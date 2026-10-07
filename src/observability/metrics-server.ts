import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { metricsContentType, renderMetrics } from './metrics.js';

// On compare des empreintes SHA-256 : timingSafeEqual exige deux buffers de même
// longueur, et cela évite aussi de révéler la longueur du token.
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export function isAuthorized(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

export function createMetricsServer(token: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(body);
    };

    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/metrics') return send(404, 'not found\n');
    if (req.method !== 'GET') return send(405, 'method not allowed\n', { allow: 'GET' });
    if (!isAuthorized(req.headers.authorization, token)) {
      return send(401, 'unauthorized\n', { 'www-authenticate': 'Bearer' });
    }

    renderMetrics()
      .then((body) => send(200, body, { 'content-type': metricsContentType }))
      .catch((err) => {
        console.error('[metrics] render failed:', err);
        send(500, 'internal error\n');
      });
  });
}

export function startMetricsServer(opts: { port: number; token: string; host?: string }): Promise<Server> {
  const server = createMetricsServer(opts.token);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function stopMetricsServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
