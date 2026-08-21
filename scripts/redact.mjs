export function redactSecrets(value, secrets) {
  let text = String(value ?? '');
  const replacements = new Set();
  for (const secret of secrets) {
    if (!secret) continue;
    replacements.add(String(secret));
    replacements.add(encodeURIComponent(String(secret)));
  }
  for (const secret of replacements) text = text.replaceAll(secret, '[REDACTED]');
  return text;
}
