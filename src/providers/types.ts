export const dataStates = [
  'complete',
  'partial',
  'zero',
  'missing',
  'stale',
  'invalid',
  'conflict',
  'unresolved',
] as const;
export type DataState = (typeof dataStates)[number];

export type ProviderDiagnostic = {
  provider: string;
  capability: string;
  status: number | null;
  latencyMs: number;
  attempts: number;
  retryAfterMs?: number;
  errorCode?: string;
};
