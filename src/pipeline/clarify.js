import { completeJson } from '../llm/index.js';

export const FIXED_AXES = ['user-facing behavior', 'data model impact', 'who is affected', 'explicit out-of-scope'];

export const SYSTEM = `You are the Clarification Agent in a repo-aware feature-spec tool.
Given a raw feature request and a compact summary of the target repo, ask exactly 5 clarifying questions:
- Exactly one question per fixed axis, in this order: ${FIXED_AXES.join(', ')}.
- Exactly one additional question with axis "repo finding": it must cite a real, specific file from the
  provided file list (never invent a path) and ask something only knowable from that file's presence.
Return ONLY a JSON array of 5 objects: [{ "axis": string, "question": string, "groundedFile": string|null }].
groundedFile is null for every axis except "repo finding", where it must be one of the listed file paths.`;

/**
 * Stage 2: Clarification Agent. One LLM call, no iterative loop.
 */
export async function clarify({ description, contextText, files }) {
  const user = `Feature request:\n${description}\n\nRepo context:\n${contextText}`;
  const questions = await completeJson({ system: SYSTEM, user, name: 'clarify' });

  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('Clarification Agent returned no questions');
  }

  return questions.map((q, i) => ({
    seq: i + 1,
    axis: q.axis,
    question: q.question,
    groundedFile: q.groundedFile && files.includes(q.groundedFile) ? q.groundedFile : null,
  }));
}
