import { completeJson } from '../llm/index.js';

export const SYSTEM = `You are the Edge Case & Dependency Agent in a repo-aware feature-spec tool.
Given a feature request, repo context, and the user's answers to clarifying questions, identify
edge cases, missing dependencies, and risks the implementation will hit.
Return ONLY a JSON array of objects: [{ "filePath": string|null, "description": string, "confidence": "high"|"medium"|"low" }].
filePath must be an exact path from the provided file list when the finding is grounded in a specific
file, or null when it is a general risk not tied to one file (e.g. "no timezone handling found in repo").
Never invent a file path that isn't in the list.`;

/**
 * Stage 4: Edge Case & Dependency Agent. Every finding must cite a real
 * file from the repo or it is marked ungrounded here (not filtered out --
 * the coverage gate and UI decide what to do with low-confidence findings).
 */
export async function edgeCases({ description, contextText, answers, files }) {
  const answersText = answers
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.flagged === 'skip' ? '(skipped)' : a.answer}`)
    .join('\n\n');

  const user = `Feature request:\n${description}\n\nRepo context:\n${contextText}\n\nClarifying Q&A:\n${answersText}`;
  const findings = await completeJson({ system: SYSTEM, user, name: 'edgeCases' });

  if (!Array.isArray(findings)) throw new Error('Edge Case Agent did not return an array');

  return findings.map((f) => ({
    filePath: f.filePath || null,
    description: f.description,
    confidence: ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium',
    grounded: Boolean(f.filePath && files.includes(f.filePath)),
  }));
}
