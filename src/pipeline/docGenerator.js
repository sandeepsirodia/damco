import { completeJson } from '../llm/index.js';

export const SYSTEM = `You are the Document Generator in a repo-aware feature-spec tool.
Given everything gathered about a feature request, write two markdown documents:
- PRD (business-framed): Problem, Goals, Non-goals, User impact, Open product questions.
- TRD (technical-framed): Architecture notes, Edge cases & dependencies, Engineering questions, Estimate.
Ground every claim in the provided repo context, answers, and findings -- cite real file paths with
backticks where relevant. Do not invent files or facts not present in the input.
Return ONLY JSON: { "prdMarkdown": string, "trdMarkdown": string }.`;

/**
 * Stage 7: Document Generator. Renders the PRD + TRD as markdown from
 * everything the earlier stages produced.
 */
export async function generateDocs({
  description,
  contextText,
  answers,
  findings,
  openQuestions,
  estimateResult,
  blastRadiusResult,
}) {
  const answersText = answers
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.flagged === 'skip' ? '(skipped)' : a.answer}`)
    .join('\n\n');
  const findingsText = findings
    .map((f) => `- ${f.filePath || '(no file)'}: ${f.description} [confidence: ${f.confidence}, grounded: ${f.grounded}]`)
    .join('\n');
  const openQuestionsText = openQuestions.map((q) => `- [${q.category}] ${q.text}`).join('\n');

  const user = [
    `Feature request:\n${description}`,
    `Repo context:\n${contextText}`,
    `Clarifying Q&A:\n${answersText}`,
    `Edge-case findings:\n${findingsText}`,
    `Open questions:\n${openQuestionsText}`,
    `Estimate: ${estimateResult.low}-${estimateResult.high} days, up to ${estimateResult.worst} worst case.`,
    `Blast radius: ${blastRadiusResult.file || '(none identified)'} with ${blastRadiusResult.count} references.`,
  ].join('\n\n');

  const { prdMarkdown, trdMarkdown } = await completeJson({ system: SYSTEM, user, name: 'docGenerator' });
  if (!prdMarkdown || !trdMarkdown) throw new Error('Document Generator did not return both prdMarkdown and trdMarkdown');
  return { prdMarkdown, trdMarkdown };
}
