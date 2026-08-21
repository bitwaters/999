import type { SafetyResult } from './safety.js';

export type SafetyGateResult<T> =
  | { called: false; reason: SafetyResult['status']; safety: SafetyResult }
  | { called: true; value: T; safety: SafetyResult };

export function runAfterSafety<T>(safety: SafetyResult, downstream: () => T): SafetyGateResult<T> {
  if (safety.status !== 'pass') return { called: false, reason: safety.status, safety };
  return { called: true, value: downstream(), safety };
}
