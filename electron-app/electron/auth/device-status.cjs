'use strict';

const APPROVAL_STATES = new Set([
  'pending_approval', 'approved', 'rejected', 'revoked',
]);

function normalizeBaseUrl(value) {
  if (!value) throw new Error('EDEN_SYNC_URL is required.');
  const url = new URL(value);
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('EDEN_SYNC_URL must use HTTPS outside localhost development.');
  }
  return url.toString().replace(/\/$/, '');
}

class DeviceStatusService {
  constructor({
    baseUrl,
    getAgentToken,
    getDeviceId,
    fetchImpl = fetch,
    onStatus = () => {},
    timeoutMs = 10000,
  }) {
    this.baseUrl = baseUrl;
    this.getAgentToken = getAgentToken;
    this.getDeviceId = getDeviceId;
    this.fetchImpl = fetchImpl;
    this.onStatus = onStatus;
    this.timeoutMs = timeoutMs;
    this.pollTimer = null;
    this.checkInProgress = false;
  }

  async checkStatus() {
    if (this.checkInProgress) return { success: false, reason: 'CHECK_ALREADY_RUNNING' };
    const token = this.getAgentToken?.();
    const deviceId = this.getDeviceId?.();
    if (!token || !deviceId) {
      return { success: false, reason: 'NOT_ENROLLED_OR_UNAUTHENTICATED' };
    }

    this.checkInProgress = true;
    try {
      const base = normalizeBaseUrl(this.baseUrl);
      const response = await this.fetchImpl(`${base}/api/v1/devices/status`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'x-device-id': deviceId,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await response.text();
      let body;
      try { body = raw ? JSON.parse(raw) : {}; }
      catch { throw new Error(`Device status API returned invalid JSON (HTTP ${response.status}).`); }
      if (!response.ok) {
        const error = new Error(body?.message || body?.code || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = body?.code || null;
        throw error;
      }
      if (!body || body.deviceId !== deviceId ||
          !APPROVAL_STATES.has(body.approvalStatus) ||
          typeof body.isActive !== 'boolean' ||
          typeof body.hasActiveCredential !== 'boolean') {
        throw new Error('Device status response does not match the expected server contract.');
      }

      const status = {
        deviceId: body.deviceId,
        approvalStatus: body.approvalStatus,
        isActive: body.isActive,
        hasActiveCredential: body.hasActiveCredential,
        serverTime: typeof body.serverTime === 'string' ? body.serverTime : null,
      };
      this.onStatus(status);
      return { success: true, ...status };
    } catch (error) {
      // A network/auth/API failure never changes trust state or local data.
      return { success: false, error: error.message, statusCode: error.status || null, code: error.code || null };
    } finally {
      this.checkInProgress = false;
    }
  }

  startPolling(intervalMs = 30000) {
    this.stopPolling();
    if (!Number.isInteger(intervalMs) || intervalMs < 5000) {
      throw new RangeError('Device status polling interval must be at least 5000 ms.');
    }
    void this.checkStatus();
    this.pollTimer = setInterval(() => { void this.checkStatus(); }, intervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

module.exports = { APPROVAL_STATES, DeviceStatusService, normalizeBaseUrl };
