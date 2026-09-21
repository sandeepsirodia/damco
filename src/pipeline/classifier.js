import { completeJson } from '../llm/index.js';

export const SYSTEM = `You are the Question Classifier in a repo-aware feature-spec tool.
Given a feature request, repo context, clarifying Q&A, and a list of edge-case findings, identify the
open items that still need a human decision before this feature can be built with confidence.
Return ONLY a JSON array of objects:
[{ "category": "PRODUCT_DECISION"|"ENGINEERING_DECISION", "text": string, "source": string, "confidence": "high"|"medium"|"low" }]
"source" is a short label like "PRD open question" or "TRD engineering question".
Do not restate answered questions. Do not invent ASSUMPTION_MADE items -- those come from unanswered
questions and are added separately.`;

/**
 * Stage 5: Question Classifier. Tags every open item PRODUCT_DECISION /
 * ENGINEERING_DECISION / ASSUMPTION_MADE with a confidence level.
 * Skipped/vague answers become ASSUMPTION_MADE deterministically (no LLM
 * needed for that half); decisions still open in the findings need one call.
 */
export async function classify({ description, contextText, answers, findings }) {
  const assumptions = answers
    .filter((a) => a.flagged === 'skip' || a.flagged === 'vague')
    .map((a) => ({
      category: 'ASSUMPTION_MADE',
      text:
        a.flagged === 'skip'
          ? `${a.axis} -- assumed from context; the question was skipped.`
          : `${a.axis} -- assumed from a vague answer: "${a.answer}"`,
      source: `${a.axis} question`,
      confidence: a.flagged === 'skip' ? 'medium' : 'low',
    }));

  const findingsText = findings
    .map((f) => `- ${f.filePath || '(no file)'}: ${f.description} [confidence: ${f.confidence}]`)
    .join('\n');
  const answersText = answers
    .filter((a) => a.flagged !== 'skip')
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  const user = `Feature request:\n${description}\n\nRepo context:\n${contextText}\n\nClarifying Q&A:\n${answersText}\n\nEdge-case findings:\n${findingsText}`;
  const decisions = await completeJson({ system: SYSTEM, user, name: 'classifier' });

  if (!Array.isArray(decisions)) throw new Error('Question Classifier did not return an array');

  const normalized = decisions
    .filter((d) => d.category === 'PRODUCT_DECISION' || d.category === 'ENGINEERING_DECISION')
    .map((d) => ({
      category: d.category,
      text: d.text,
      source: d.source || null,
      confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'medium',
    }));

  return [...normalized, ...assumptions];
}
