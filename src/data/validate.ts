/**
 * Minimal runtime guards for untrusted JSON (network responses, localStorage).
 * Every external value goes through these before reaching the domain.
 */

export type Json = unknown;

export function isRecord(v: Json): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: Json, maxLen = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= maxLen ? s : null;
}

export function num(v: Json, min = -Infinity, max = Infinity): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

export function int(v: Json, min: number, max: number): number | null {
  const n = num(v, min, max);
  return n !== null && Number.isInteger(n) ? n : null;
}

export function bool(v: Json): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function oneOf<T extends string>(v: Json, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function arr(v: Json, maxLen = 5000): unknown[] | null {
  return Array.isArray(v) && v.length <= maxLen ? v : null;
}

/** ISO-8601 timestamp → epoch ms, or null. */
export function isoTime(v: Json): number | null {
  const s = str(v, 40);
  if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Identifier restricted to a safe charset (used as map keys and in URLs). */
export function safeId(v: Json): string | null {
  const s = str(v, 80);
  return s && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : null;
}

/** External link from untrusted data: https only, no credentials, bounded length; else null. */
export function safeUrl(v: Json): string | null {
  const s = str(v, 300);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
    return u.href;
  } catch {
    return null;
  }
}
