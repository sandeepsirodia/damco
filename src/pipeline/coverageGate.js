/**
 * Stage 8: Coverage Gate. Pure code, no LLM -- blocks before finalizing if
 * a discovered finding never made it into the final docs. Findings with a
 * file path are checked by exact path match; general findings (no file)
 * fall back to keyword overlap since there's no citation to match on.
 */
export function coverageGate({ findings, prdMarkdown, trdMarkdown }) {
  const combined = `${prdMarkdown}\n${trdMarkdown}`;

  const missing = findings.filter((f) => {
    if (f.filePath) return !combined.includes(f.filePath);
    const distinctiveWords = f.description
      .split(/\s+/)
      .filter((w) => w.length > 6)
      .slice(0, 3);
    if (distinctiveWords.length === 0) return false;
    const lowerCombined = combined.toLowerCase();
    return !distinctiveWords.some((w) => lowerCombined.includes(w.toLowerCase()));
  });

  return {
    passed: missing.length === 0,
    missing: missing.map((f) => f.filePath || f.description),
  };
}
