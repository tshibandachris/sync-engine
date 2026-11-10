'use strict';

const DEVICE_TRUST_STATES = Object.freeze([
  'unregistered', 'awaiting_approval', 'approved', 'revoked',
]);
const AGENT_AUTH_STATES = Object.freeze(['unauthenticated', 'authenticated']);

function deriveDeviceTrustState(credential) {
  // A locally stored key proves possession capability, not server approval.
  // Until a server-authenticated status response exists, fail closed.
  return credential?.deviceId ? 'awaiting_approval' : 'unregistered';
}

function canAccessLocalPOS(agentAuthState, _deviceTrustState) {
  return agentAuthState === 'authenticated';
}

function canRunSync(agentAuthState, deviceTrustState) {
  return agentAuthState === 'authenticated' && deviceTrustState === 'approved';
}

module.exports = {
  AGENT_AUTH_STATES,
  DEVICE_TRUST_STATES,
  canAccessLocalPOS,
  canRunSync,
  deriveDeviceTrustState,
};
