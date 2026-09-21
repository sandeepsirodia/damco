/**
 * Stage 6: Estimate Generator. Pure heuristic, no LLM call -- range width
 * is a direct function of blast-radius size and unresolved/low-confidence
 * open items, exactly as scoped in the plan.
 */
export function estimate({ blastRadiusCount, openQuestions }) {
  let low = 2;
  let high = 3;

  if (blastRadiusCount >= 10) high += 2;
  else if (blastRadiusCount >= 5) high += 1;

  const lowConfidenceCount = openQuestions.filter((q) => q.confidence === 'low').length;
  high += Math.min(lowConfidenceCount, 3);

  const worst = high + Math.max(2, Math.ceil(openQuestions.length * 0.75));

  return { low, high, worst };
}
