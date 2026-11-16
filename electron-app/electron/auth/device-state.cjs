'use strict';

const DEVICE_TRUST_STATES = Object.freeze([
  'unregistered', 'awaiting_approval', 'approved', 'rejected', 'revoked', 'deactivated',
]);
const AGENT_AUTH_STATES = Object.freeze(['unauthenticated', 'authenticated']);

function deriveDeviceTrustState(credential, approvalDecision = null) {
  // A credential alone proves possession, never approval. A cached decision is
  // trusted only when its device and tenant bindings match this credential.
  if (!credential?.deviceId) return 'unregistered';
  if (!approvalDecision ||
      approvalDecision.deviceId !== credential.deviceId ||
      approvalDecision.tenantId !== credential.tenantId) return 'awaiting_approval';
  if (!approvalDecision.isActive) return 'deactivated';
  return approvalDecision.approvalStatus === 'pending_approval'
    ? 'awaiting_approval' : approvalDecision.approvalStatus;
}

function canReadLocalData(agentAuthState, deviceTrustState) {
  return agentAuthState === 'authenticated' &&
    ['awaiting_approval', 'approved', 'rejected', 'revoked', 'deactivated'].includes(deviceTrustState);
}

function canAccessLocalPOS(agentAuthState, deviceTrustState) {
  // Offline-first writes are allowed only after a server-confirmed approval.
  // A transient network/API failure does not change this trust state.
  return agentAuthState === 'authenticated' && deviceTrustState === 'approved';
}

function canRunSync(agentAuthState, deviceTrustState, deviceProofReady = false) {
  // Approval is necessary but not sufficient: the local ES256 key must be
  // available and the server must confirm an active credential.
  return agentAuthState === 'authenticated' &&
    deviceTrustState === 'approved' &&
    deviceProofReady === true;
}

module.exports = {
  AGENT_AUTH_STATES,
  DEVICE_TRUST_STATES,
  canAccessLocalPOS,
  canReadLocalData,
  canRunSync,
  deriveDeviceTrustState,
};
