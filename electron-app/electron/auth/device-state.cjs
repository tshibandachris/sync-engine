'use strict';

const DEVICE_TRUST_STATES = Object.freeze([
  'unregistered', 'awaiting_approval', 'approved', 'rejected', 'revoked', 'deactivated',
]);
const AGENT_AUTH_STATES = Object.freeze(['unauthenticated', 'authenticated']);

function deriveDeviceTrustState(credential) {
  // A locally stored key proves possession capability, not server approval.
  // Only DeviceStatusService may transition this state to a server-confirmed value.
  return credential?.deviceId ? 'awaiting_approval' : 'unregistered';
}

function canAccessLocalPOS(agentAuthState, _deviceTrustState) {
  return agentAuthState === 'authenticated';
}

function canRunSync(agentAuthState, deviceTrustState, deviceProofReady = false) {
  // Approval is necessary but not sufficient. The ES256 request-signing client
  // is deliberately not enabled until its server enrollment/PoP contract ships.
  return agentAuthState === 'authenticated' &&
    deviceTrustState === 'approved' &&
    deviceProofReady === true;
}

module.exports = {
  AGENT_AUTH_STATES,
  DEVICE_TRUST_STATES,
  canAccessLocalPOS,
  canRunSync,
  deriveDeviceTrustState,
};
