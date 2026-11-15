'use strict';

const { pushChanges } = require('./api-client.cjs');
const { preparePushBatch, applyPushResponse } = require('./outbox.cjs');

/**
 * Push one persisted Outbox batch and acknowledge it only after the server
 * response has passed the API client's success and payload-contract checks.
 * A rejected HTTP request or network error exits before applyPushResponse,
 * leaving the batch and its idempotency key available for an exact retry.
 */
async function pushPendingBatch({
  db,
  baseUrl,
  token,
  deviceId,
  privateKeyPem,
  fetchImpl,
}) {
  const batch = preparePushBatch(db);
  if (!batch) return { sent: false, acknowledged: 0, retained: 0 };

  const response = await pushChanges({
    baseUrl,
    token,
    deviceId,
    privateKeyPem,
    idempotencyKey: batch.idempotencyKey,
    payload: batch.payload,
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  const result = applyPushResponse(db, batch, response);
  return { sent: true, ...result };
}

module.exports = { pushPendingBatch };
