import { redactSecrets } from './redact.mjs';

const sensitiveKeyPattern = /^(authorization|api[_-]?key|access[_-]?token|headers)$/iu;

export function sanitizeGmgnFixture(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => sanitizeGmgnFixture(item, secrets));
  if (!value || typeof value !== 'object') return redactSecrets(value, secrets);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !sensitiveKeyPattern.test(key))
      .map(([key, item]) => [key, sanitizeGmgnFixture(item, secrets)]),
  );
}
