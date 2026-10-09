/**
 * Drizzle 0.45 wraps driver errors ("Failed query: ..."): the PostgreSQL message and the
 * SQLSTATE live on `cause`. Flatten the chain so assertions can match the real error.
 */
export function pgErrorChain(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let cur: unknown = err; cur && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    const e = cur as { message?: unknown; code?: unknown };
    parts.push(String(e.message ?? cur));
    if (e.code) parts.push('[' + String(e.code) + ']');
  }
  return parts.join(' | ');
}
