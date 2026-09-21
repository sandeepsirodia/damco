#!/usr/bin/env node
// Eval runner for the "Clarification Agent" + "Question Classifier" flow
// (src/pipeline/clarify.js, src/pipeline/classifier.js) -- the two LLM-calling
// stages with NO prior correctness check of any kind, deterministic or
// otherwise. Two layers, in the priority order laid out for this project:
//
//   1. Deterministic (code-graded, no judge involved):
//      - axis_correct: the 5 questions hit the 4 fixed axes in order, plus
//        exactly one "repo finding" axis question (SYSTEM's own contract).
//      - repo_finding_grounded: that "repo finding" question's groundedFile
//        is either null or a real file -- checked against the RAW model
//        output, not clarify()'s already-sanitized return value (clarify.js
//        silently nulls a hallucinated path before returning; grading the
//        sanitized value would make this check vacuously always pass).
//   2. LLM-judge (subjective, can't be checked by code):
//      - distinct: no two of the 5 questions ask the same thing.
//      - specific: each question is specific to this feature+repo, not a
//        generic template question.
//      - classifier_sound: the classifier's open items are genuinely still
//        open, not restating something the user already answered.
//
//   node eval/run-question-eval.mjs --flow eval/question-quality --variant baseline --approve-harness
//
// Reuses eval/edge-case-grounding's cases.json / repo-fixtures.json / reused
// baseline findings, same as run-doc-eval.mjs -- see that file for why.
//
// The harness itself lives in eval/lib/harness.mjs, shared with run-eval.mjs
// and run-doc-eval.mjs.
//
// KNOWN LIMITATION: the judge call uses this project's OWN configured
// LLM_PROVIDER/model (via complete()) to grade output from that same
// provider/model. That's same-model judging, a real bias risk (a model is
// more likely to rate its own phrasing as "specific" than an independent
// judge would) -- there's no second, independently-configured model in this
// model-agnostic-by-design app to grade against instead. Read judge scores
// as a directional signal, not a certification; the `explanation` field on
// every row names the specific question/item that drove each score so a
// human can spot-check disagreement rather than trust the number blind.
//
// KNOWN LIMITATION (inherited from run-eval.mjs, see its header): usage/cost
// are omitted -- the provider adapters don't expose token counts.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeJson } from '../src/llm/index.js';
import { SYSTEM as CLARIFY_SYSTEM, FIXED_AXES } from '../src/pipeline/clarify.js';
import { classify, SYSTEM as CLASSIFY_SYSTEM } from '../src/pipeline/classifier.js';
import { runEvalSuite } from './lib/harness.mjs';

// --- filled in for this flow -------------------------------------------------

async function loadCases() {
  const here = resolve(fileURLToPath(import.meta.url), '..');
  const edgeDir = join(here, 'edge-case-grounding');
  const cases = JSON.parse(readFileSync(join(edgeDir, 'cases.json'), 'utf8'));
  const repos = JSON.parse(readFileSync(join(edgeDir, 'repo-fixtures.json'), 'utf8'));

  return cases.map((c) => {
    const tracePath = join(edgeDir, 'baseline', 'traces', `${c.id}_rep0.json`);
    const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
    const findings = JSON.parse(trace.find((m) => m.role === 'assistant').content);
    return {
      id: c.id,
      tags: c.tags,
      description: c.description,
      answers: c.answers,
      files: repos[c.repo].files,
      contextText: repos[c.repo].contextText,
      findings,
    };
  });
}

const JUDGE_SYSTEM = `You are grading the output of two pipeline stages in a repo-aware feature-spec tool:
the Clarification Agent (asks 5 questions up front, before any answer exists) and the Question Classifier
(triages open items into PRODUCT_DECISION / ENGINEERING_DECISION after the user answers). You did NOT
write this output -- grade it strictly and cite specific evidence. Do not give credit for output that
merely looks plausible or professional; look for the specific failure modes named below.

Score each dimension 0 (fail) or 1 (pass):
- distinct: no two of the 5 clarifying questions ask substantially the same thing in different words.
- specific: every clarifying question is specific to THIS feature request and repo -- not a generic
  template question (e.g. "what should happen on error?") that could be pasted unchanged into a spec
  for a completely different feature.
- classifier_sound: every PRODUCT_DECISION / ENGINEERING_DECISION item is something genuinely still open
  (the user did not already answer it in the Q&A), and it is not a verbatim restatement of one of the 5
  clarifying questions.

Return ONLY JSON:
{ "distinct": 0|1, "specific": 0|1, "classifier_sound": 0|1,
  "explanation": { "distinct": string, "specific": string, "classifier_sound": string } }
Each explanation must name the specific question or item that drove the score -- not a general impression.`;

function gradeDeterministic(input, rawQuestions) {
  const expectedAxes = [...FIXED_AXES, 'repo finding'];
  const actualAxes = rawQuestions.map((q) => q.axis);
  const axis_correct = JSON.stringify(actualAxes) === JSON.stringify(expectedAxes) ? 1 : 0;

  const repoFindingQ = rawQuestions.find((q) => q.axis === 'repo finding');
  const groundedFile = repoFindingQ?.groundedFile ?? null;
  const repo_finding_grounded = groundedFile === null || input.files.includes(groundedFile) ? 1 : 0;

  return {
    grade: { axis_correct, repo_finding_grounded },
    explanation: {
      axis_correct: `expected [${expectedAxes.join(', ')}], got [${actualAxes.join(', ')}]`,
      repo_finding_grounded:
        groundedFile === null
          ? 'no groundedFile cited (not a hallucination, just ungrounded)'
          : input.files.includes(groundedFile)
            ? `grounded: ${groundedFile}`
            : `HALLUCINATED: "${groundedFile}" is not in the repo's file list`,
    },
  };
}

async function runCase(input, ctx) {
  // Call clarify's SYSTEM directly (not the clarify() wrapper) so we see the
  // model's RAW groundedFile before clarify.js silently nulls a bad one --
  // grading the sanitized value would make repo_finding_grounded vacuous.
  const clarifyUser = `Feature request:\n${input.description}\n\nRepo context:\n${input.contextText}`;
  const rawQuestions = await completeJson({ system: CLARIFY_SYSTEM, user: clarifyUser, name: 'clarify-eval' });
  if (!Array.isArray(rawQuestions) || rawQuestions.length !== 5) {
    throw new Error(
      `Clarification Agent returned ${Array.isArray(rawQuestions) ? rawQuestions.length : typeof rawQuestions} questions, expected 5`
    );
  }

  // Real classify() call -- exercises the actual stage, not a reimplementation.
  const openQuestions = await classify({
    description: input.description,
    contextText: input.contextText,
    answers: input.answers,
    findings: input.findings,
  });

  const questionsText = rawQuestions.map((q) => `[${q.axis}] ${q.question}`).join('\n');
  const answersText = input.answers
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.flagged === 'skip' ? '(skipped)' : a.answer}`)
    .join('\n\n');
  const openQuestionsText = openQuestions.map((q) => `[${q.category}] ${q.text}`).join('\n');
  const judgeUser = [
    `Feature request:\n${input.description}`,
    `Repo context (trimmed):\n${input.contextText.slice(0, 1500)}`,
    `Clarifying questions asked:\n${questionsText}`,
    `User's answers:\n${answersText}`,
    `Classifier's open questions:\n${openQuestionsText}`,
  ].join('\n\n');
  const judged = await completeJson({ system: JUDGE_SYSTEM, user: judgeUser, name: 'question-quality-judge' });

  return {
    output: JSON.stringify({ rawQuestions, openQuestions, judged }),
    transcript: [
      { role: 'system', content: CLARIFY_SYSTEM },
      { role: 'user', content: clarifyUser },
      { role: 'assistant', content: JSON.stringify(rawQuestions, null, 2) },
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'assistant', content: JSON.stringify(openQuestions, null, 2), name: 'classifier-output' },
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: judgeUser },
      { role: 'assistant', content: JSON.stringify(judged, null, 2), name: 'judge-verdict' },
    ],
    model: ctx.model || process.env[`${(process.env.LLM_PROVIDER || 'gemini').toUpperCase()}_MODEL`] || process.env.LLM_PROVIDER || 'unknown',
    rawQuestions,
    openQuestions,
    judged,
  };
}

async function gradeCase(input, run) {
  const det = gradeDeterministic(input, run.rawQuestions);
  const j = run.judged || {};
  return {
    grade: {
      ...det.grade,
      distinct: j.distinct === 1 ? 1 : 0,
      specific: j.specific === 1 ? 1 : 0,
      classifier_sound: j.classifier_sound === 1 ? 1 : 0,
    },
    explanation: {
      ...det.explanation,
      distinct: j.explanation?.distinct || '(judge gave no explanation)',
      specific: j.explanation?.specific || '(judge gave no explanation)',
      classifier_sound: j.explanation?.classifier_sound || '(judge gave no explanation)',
    },
    judge_model: run.model,
  };
}

function perfFrom(run) {
  return {
    question_count: run.rawQuestions.length,
    open_question_count: run.openQuestions.length,
  };
}

runEvalSuite({ scriptName: 'run-question-eval.mjs', harnessSelfUrl: import.meta.url, loadCases, runCase, gradeCase, perfFrom });
