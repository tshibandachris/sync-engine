function decodeJsonSegment(segment, label) {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`Le segment ${label} du JWT est invalide.`);
  }
  let value;
  try { value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); }
  catch { throw new Error(`Le segment ${label} du JWT n’est pas un JSON valide.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Le segment ${label} du JWT doit être un objet JSON.`);
  }
  return value;
}

/**
 * Performs structural checks only. The NestJS API remains responsible for
 * cryptographic signature, issuer, audience and authorization validation.
 */
function validateDeviceToken(value, nowMs = Date.now()) {
  if (typeof value !== 'string') throw new Error('Collez un JWT d’appareil valide.');
  const token = value.trim();
  if (!token || token.length > 16384) throw new Error('Le JWT est vide ou trop long.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Format JWT invalide : trois segments sont requis.');
  const header = decodeJsonSegment(parts[0], 'header');
  const payload = decodeJsonSegment(parts[1], 'payload');
  if (typeof header.alg !== 'string' || !header.alg.trim() || header.alg.toLowerCase() === 'none') {
    throw new Error('Le JWT doit déclarer un algorithme de signature.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2]) || Buffer.from(parts[2], 'base64url').length === 0) {
    throw new Error('La signature du JWT est absente ou invalide.');
  }
  if (payload.exp !== undefined && (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(nowMs / 1000))) {
    throw new Error('Le JWT est expiré ou contient une date d’expiration invalide.');
  }
  return token;
}

module.exports = { validateDeviceToken };
