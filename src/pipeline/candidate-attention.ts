import type { BotConfig } from '../config/schema.js';
import { evaluateAttention } from './ace.js';
import type { DiscoveryObservation } from './candidate.js';

export function evaluateCandidateAttention(
  evidence: readonly DiscoveryObservation[],
  config: BotConfig['strategies']['emerging_breakout']['attention'],
): ReturnType<typeof evaluateAttention> {
  const decisions = attentionInputs(evidence).map((input) => evaluateAttention(input, config));
  if (decisions.length === 0) return { status: 'incomplete', reasons: ['missing:attention'] };
  if (decisions.some((decision) => decision.status === 'pass')) return { status: 'pass', reasons: [] };
  const reasons = [...new Set(decisions.flatMap((decision) => decision.reasons))];
  if (decisions.some((decision) => decision.status === 'incomplete'))
    return { status: 'incomplete', reasons: reasons.length > 0 ? reasons : ['missing:attention'] };
  return { status: 'rejected', reasons: reasons.length > 0 ? reasons : ['rejected:attention'] };
}

function attentionInputs(evidence: readonly DiscoveryObservation[]): Array<{
  rankBefore?: number;
  rankAfter?: number;
  visitingBefore?: number;
  visitingAfter?: number;
}> {
  const bySource = new Map<string, DiscoveryObservation[]>();
  for (const item of evidence)
    bySource.set(item.source, [...(bySource.get(item.source) ?? []), item]);
  return [...bySource.values()]
    .map((items) => items.sort((left, right) => left.observedAt - right.observedAt))
    .filter((items) => items.length >= 2)
    .map((items) => {
      const previous = items.at(-2)!;
      const latest = items.at(-1)!;
      return items[0]!.source === 'hot_searches'
        ? {
            ...(previous.visitingCount === undefined
              ? {}
              : { visitingBefore: previous.visitingCount }),
            ...(latest.visitingCount === undefined ? {} : { visitingAfter: latest.visitingCount }),
          }
        : {
            ...(previous.rank === undefined ? {} : { rankBefore: previous.rank }),
            ...(latest.rank === undefined ? {} : { rankAfter: latest.rank }),
          };
    });
}
