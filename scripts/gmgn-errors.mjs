export function isGmgnRateLimitOrBan(value) {
  return /(?:HTTP\s*429|code=429|rate.?limit|too many requests|banned|temporar(?:y|ily)\s+banned)/iu.test(
    String(value ?? ''),
  );
}
