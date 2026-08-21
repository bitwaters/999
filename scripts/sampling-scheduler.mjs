export const PRIMARY_DISCOVERY_SOURCES = new Set(['trending', 'hot-searches']);

export function discoveryCategory(source) {
  return PRIMARY_DISCOVERY_SOURCES.has(source) ? 'primary' : 'auxiliary';
}

export function retryDelaySeconds(attempt, initialSeconds, maxSeconds) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  return Math.min(
    maxSeconds,
    initialSeconds * 2 ** Math.min(Math.max(normalizedAttempt - 1, 0), 30),
  );
}

export function isCandidateDue(candidate, now) {
  return (
    candidate.next_retry_at === null ||
    candidate.next_retry_at === undefined ||
    Number(candidate.next_retry_at) <= now
  );
}

function compareDueCandidates(left, right) {
  const leftRetry = left.next_retry_at === null ? 0 : Number(left.next_retry_at);
  const rightRetry = right.next_retry_at === null ? 0 : Number(right.next_retry_at);
  return (
    leftRetry - rightRetry ||
    Number(left.first_seen_at) - Number(right.first_seen_at) ||
    String(left.token_address).localeCompare(String(right.token_address))
  );
}

export function selectIndexingCandidates(rows, { now, cutoff, limit }) {
  const due = rows
    .filter(
      (row) =>
        Number(row.first_seen_at) >= cutoff &&
        row.resolved !== true &&
        Number(row.resolved ?? 0) !== 1 &&
        isCandidateDue(row, now),
    )
    .sort((left, right) => {
      const leftPriority = left.source_category === 'primary' ? 0 : 1;
      const rightPriority = right.source_category === 'primary' ? 0 : 1;
      return leftPriority - rightPriority || compareDueCandidates(left, right);
    });
  const primary = due.filter((row) => row.source_category === 'primary');
  const auxiliary = due.filter((row) => row.source_category !== 'primary');
  return primary.slice(0, limit).concat(auxiliary.slice(0, Math.max(0, limit - primary.length)));
}

export function classifyIndexingResult({ token, relationships, topPoolRows, pool, poolAddress }) {
  if (!token) return 'token_absent';
  if (!relationships) return 'pool_relationship_missing';
  if (!relationships.top_pools) return 'pool_relationship_missing';
  if (!Array.isArray(topPoolRows) || topPoolRows.length === 0) return 'token_present_no_top_pool';
  if (!pool) return 'included_pool_missing';
  if (!poolAddress) return 'invalid_pool_identity';
  return 'resolved';
}
