import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
export const hashObject = (v: unknown): string => sha256Hex(stableStringify(v));
