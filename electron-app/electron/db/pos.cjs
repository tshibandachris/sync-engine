'use strict';

const { randomUUID } = require('node:crypto');
const { enqueueOutbox } = require('../sync/outbox.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value, field) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${field} doit être un UUID valide.`);
  }
}

function requireAmount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} doit être un montant entier positif ou nul en CDF.`);
  }
}

function listLocalStaff(db) {
  return db.prepare(`
    SELECT id, display_name AS displayName, role
    FROM staff
    WHERE is_active = 1 AND deleted_at IS NULL
    ORDER BY display_name COLLATE NOCASE
    LIMIT 200
  `).all();
}

function listOpenCashSessions(db) {
  return db.prepare(`
    SELECT cs.id, cs.status, cs.staff_id AS staffId, s.display_name AS staffName,
           cs.opened_at AS openedAt, cs.opening_amount AS openingAmount,
           cs.notes, cs.close_requested_at AS closeRequestedAt,
           cs.close_closing_amount AS closeClosingAmount,
           cs.close_sync_state AS closeSyncState, cs.close_sync_error AS closeSyncError,
           cs.opening_amount + COALESCE((
             SELECT SUM(sale.cash_amount) FROM sales sale
             WHERE sale.cash_session_id = cs.id
           ), 0) AS expectedCash
    FROM cash_sessions cs
    JOIN staff s ON s.id = cs.staff_id
    WHERE cs.status = 'open' AND cs.closed_at IS NULL
    ORDER BY cs.opened_at DESC
    LIMIT 200
  `).all().map((row) => ({
    ...row,
    openedAt: Number(row.openedAt),
    openingAmount: Number(row.openingAmount),
    expectedCash: Number(row.expectedCash),
    closeRequested: row.closeRequestedAt != null,
    closeClosingAmount: row.closeClosingAmount == null ? null : Number(row.closeClosingAmount),
    closeSyncState: row.closeSyncState ?? null,
    closeSyncError: row.closeSyncError ?? null,
  }));
}

function openCashSession(db, input, now = Date.now()) {
  requireUuid(input?.staffId, 'staffId');
  requireAmount(input?.openingAmount, 'openingAmount');
  const terminalLabel = input.terminalLabel == null ? null : String(input.terminalLabel).trim();
  if (terminalLabel && terminalLabel.length > 40) {
    throw new Error('Le nom du terminal ne peut pas dépasser 40 caractères.');
  }

  const staff = db.prepare(`
    SELECT id FROM staff WHERE id = ? AND is_active = 1 AND deleted_at IS NULL
  `).get(input.staffId);
  if (!staff) throw new Error('Le membre du personnel est introuvable ou inactif sur ce terminal.');

  const id = randomUUID();
  const payload = {
    id,
    staffId: input.staffId,
    terminalLabel: terminalLabel || null,
    openedAt: now,
    openingAmount: input.openingAmount,
    status: 'open',
    closedAt: null,
    closingAmount: null,
    expectedAmount: null,
    difference: null,
    notes: null,
    createdAt: now,
    lastKnownSyncSeq: 0,
  };

  const save = db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM cash_sessions
      WHERE staff_id = ? AND status = 'open' AND closed_at IS NULL
      LIMIT 1
    `).get(input.staffId);
    if (existing) throw new Error('Ce membre du personnel possède déjà une session de caisse ouverte.');

    db.prepare(`
      INSERT INTO cash_sessions (
        id, staff_id, terminal_label, opened_at, closed_at, opening_amount,
        closing_amount, expected_amount, difference, status, notes, created_at,
        updated_at, last_known_sync_seq
      ) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, 'open', NULL, ?, ?, 0)
    `).run(id, input.staffId, payload.terminalLabel, now, input.openingAmount, now, now);

    enqueueOutbox(db, {
      entityType: 'cash_sessions',
      entityId: id,
      operation: 'create',
      payload,
      now,
    });
  });
  save();
  return listOpenCashSessions(db).find((session) => session.id === id);
}

function requestCashSessionClose(db, input, now = Date.now()) {
  requireUuid(input?.cashSessionId, 'cashSessionId');
  requireAmount(input?.closingAmount, 'closingAmount');
  const notes = input.notes == null ? null : String(input.notes).trim() || null;
  if (notes && notes.length > 500) throw new Error('La note de clôture ne peut pas dépasser 500 caractères.');
  const result = db.prepare(`
    UPDATE cash_sessions SET close_requested_at = ?, close_closing_amount = ?,
      close_notes = ?, close_sync_state = 'pending', close_sync_error = NULL
    WHERE id = ? AND status = 'open' AND closed_at IS NULL AND close_requested_at IS NULL
  `).run(now, input.closingAmount, notes, input.cashSessionId);
  if (result.changes !== 1) throw new Error('Session introuvable, déjà clôturée ou clôture déjà demandée.');
  return { cashSessionId: input.cashSessionId, closingAmount: input.closingAmount, requestedAt: now, syncState: 'pending' };
}

function listRecentClosedCashSession(db) {
  return db.prepare(`
    SELECT cs.id, s.display_name AS staffName, cs.closed_at AS closedAt,
      cs.closing_amount AS closingAmount, cs.expected_amount AS expectedAmount, cs.difference
    FROM cash_sessions cs JOIN staff s ON s.id = cs.staff_id
    WHERE cs.status = 'closed' AND cs.closed_at IS NOT NULL
    ORDER BY cs.closed_at DESC LIMIT 1
  `).get() || null;
}

function createLocalSale(db, input, now = Date.now()) {
  requireUuid(input?.cashSessionId, 'cashSessionId');
  if (!Array.isArray(input?.lines) || input.lines.length < 1 || input.lines.length > 100) {
    throw new Error('Le panier doit contenir entre 1 et 100 lignes.');
  }

  const session = db.prepare(`
    SELECT id, staff_id AS staffId
    FROM cash_sessions
    WHERE id = ? AND status = 'open' AND closed_at IS NULL AND close_requested_at IS NULL
  `).get(input.cashSessionId);
  if (!session) throw new Error('Aucune session de caisse ouverte ne permet cet encaissement.');

  const paymentMethod = input.paymentMethod;
  if (!['cash', 'mobile_money', 'mixed'].includes(paymentMethod)) {
    throw new Error('Mode de paiement invalide.');
  }

  const products = new Map();
  for (const line of input.lines) {
    requireUuid(line?.productId, 'productId');
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 100000) {
      throw new Error('Chaque quantité doit être un entier strictement positif.');
    }
    const product = db.prepare(`
      SELECT id, name, sku, price, cost, is_active AS isActive, deleted_at AS deletedAt
      FROM products WHERE id = ?
    `).get(line.productId);
    if (!product || !product.isActive || product.deletedAt != null) {
      throw new Error('Un produit du panier est introuvable ou inactif.');
    }
    const unitPrice = Number(product.price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
      throw new Error('Le prix local du produit est invalide.');
    }
    const unitCost = product.cost == null ? null : Number(product.cost);
    if (unitCost !== null && (!Number.isSafeInteger(unitCost) || unitCost < 0)) {
      throw new Error('Le coût local du produit est invalide.');
    }
    const previous = products.get(product.id);
    const quantity = (previous?.quantity || 0) + line.quantity;
    if (!Number.isSafeInteger(quantity)) throw new Error('Quantité totale invalide.');
    products.set(product.id, { product, quantity, unitPrice, unitCost });
  }

  let total = 0;
  const saleLines = [];
  const movements = [];
  const saleId = randomUUID();
  for (const { product, quantity, unitPrice, unitCost } of products.values()) {
    const subtotal = quantity * unitPrice;
    if (!Number.isSafeInteger(subtotal)) throw new Error('Sous-total hors limite.');
    total += subtotal;
    if (!Number.isSafeInteger(total)) throw new Error('Total de vente hors limite.');

    const stock = db.prepare('SELECT SUM(quantity_delta) AS quantity FROM stock_movements WHERE product_id = ?').get(product.id);
    if (stock.quantity != null && Number(stock.quantity) < quantity) {
      throw new Error(`Stock insuffisant pour « ${product.name} ».`);
    }

    const lineId = randomUUID();
    saleLines.push({
      id: lineId,
      product_id: product.id,
      product_name: product.name,
      product_sku: product.sku ?? null,
      quantity,
      unit_price: unitPrice,
      subtotal,
      created_at: now,
      updated_at: now,
    });
    movements.push({
      id: randomUUID(),
      product_id: product.id,
      movement_type: 'sale',
      quantity_delta: -quantity,
      reference_id: saleId,
      reference_type: 'sale',
      unit_cost: unitCost,
      notes: null,
      created_at: now,
      updated_at: now,
      created_by: session.staffId,
    });
  }

  if (total <= 0) throw new Error('Le total de la vente doit être supérieur à zéro.');
  const cashAmount = input.cashAmount;
  const mobileAmount = input.mobileAmount;
  requireAmount(cashAmount, 'cashAmount');
  requireAmount(mobileAmount, 'mobileAmount');
  if (cashAmount + mobileAmount !== total) {
    throw new Error('La somme des parts espèces et mobile money doit égaler le total.');
  }
  if ((paymentMethod === 'cash' && (cashAmount !== total || mobileAmount !== 0)) ||
      (paymentMethod === 'mobile_money' && (mobileAmount !== total || cashAmount !== 0)) ||
      (paymentMethod === 'mixed' && (cashAmount === 0 || mobileAmount === 0))) {
    throw new Error('Répartition des moyens de paiement incohérente.');
  }

  const saleNumber = `S-${now.toString(36).toUpperCase()}-${saleId.slice(0, 8).toUpperCase()}`;
  const payload = {
    id: saleId,
    cash_session_id: session.id,
    staff_id: session.staffId,
    sale_number: saleNumber,
    total,
    payment_method: paymentMethod,
    cash_amount: cashAmount,
    mobile_amount: mobileAmount,
    mobile_msisdn: input.mobileMsisdn == null ? null : String(input.mobileMsisdn).trim() || null,
    mobile_reference: input.mobileReference == null ? null : String(input.mobileReference).trim() || null,
    customer_note: input.customerNote == null ? null : String(input.customerNote).trim() || null,
    is_void: false,
    voided_sale_id: null,
    void_reason: null,
    created_at: now,
    updated_at: now,
    lines: saleLines,
    stock_movements: movements,
  };
  if (payload.mobile_msisdn && payload.mobile_msisdn.length > 20) throw new Error('Le numéro mobile money est trop long.');
  if (payload.mobile_reference && payload.mobile_reference.length > 64) throw new Error('La référence mobile money est trop longue.');
  if (payload.customer_note && payload.customer_note.length > 200) throw new Error('La note client est trop longue.');

  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO sales (
        id, cash_session_id, staff_id, sale_number, total, payment_method,
        cash_amount, mobile_amount, mobile_msisdn, mobile_reference, customer_note,
        is_void, voided_sale_id, void_reason, created_at, updated_at, last_known_sync_seq
      ) VALUES (
        @id, @cash_session_id, @staff_id, @sale_number, @total, @payment_method,
        @cash_amount, @mobile_amount, @mobile_msisdn, @mobile_reference, @customer_note,
        0, NULL, NULL, @created_at, @updated_at, 0
      )
    `).run(payload);

    const insertLine = db.prepare(`
      INSERT INTO sale_lines (
        id, sale_id, product_id, product_name, product_sku, quantity,
        unit_price, subtotal, created_at, updated_at, last_known_sync_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    for (const line of saleLines) {
      insertLine.run(line.id, saleId, line.product_id, line.product_name, line.product_sku,
        line.quantity, line.unit_price, line.subtotal, now, now);
    }

    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (
        id, product_id, movement_type, quantity_delta, reference_id,
        reference_type, unit_cost, notes, created_at, updated_at, created_by,
        last_known_sync_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    for (const movement of movements) {
      insertMovement.run(movement.id, movement.product_id, movement.movement_type,
        movement.quantity_delta, movement.reference_id, movement.reference_type,
        movement.unit_cost, movement.notes, movement.created_at, movement.updated_at,
        movement.created_by);
    }

    enqueueOutbox(db, {
      entityType: 'sales',
      entityId: saleId,
      operation: 'create',
      payload,
      now,
    });
  });
  save();

  return {
    id: saleId,
    saleNumber,
    total,
    paymentMethod,
    cashAmount,
    mobileAmount,
    lineCount: saleLines.length,
    createdAt: now,
  };
}

module.exports = {
  listLocalStaff,
  listOpenCashSessions,
  listRecentClosedCashSession,
  openCashSession,
  requestCashSessionClose,
  createLocalSale,
};
