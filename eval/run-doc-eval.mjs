#!/usr/bin/env node
// Eval runner for the "Document Generator" flow (src/pipeline/docGenerator.js).
// Same grounding methodology as run-eval.mjs's edge-case-grounding suite, aimed
// at the actual deliverable this time: every real-looking file path cited with
// backticks in the generated PRD/TRD must be a real file in the repo, never a
// hallucinated one.
//
//   node eval/run-doc-eval.mjs --flow eval/doc-generator-grounding --variant baseline --approve-harness
//
// Reuses eval/edge-case-grounding's cases.json / repo-fixtures.json (same 18
// cases, same repo fixtures) rather than duplicating them, and reuses the
// REAL findings already captured in edge-case-grounding/baseline/traces/ so
// this suite doesn't re-spend an edgeCases LLM call per case. It does spend
// one real classifier() call per case (cheap) to get authentic openQuestions
// rather than fabricate them -- see loadCases() below for what's synthesized
// vs. real.
//
// The harness itself lives in eval/lib/harness.mjs, shared with run-eval.mjs
// and run-question-eval.mjs.
//
// KNOWN LIMITATION (inherited from run-eval.mjs, see its header): usage/cost
// are omitted -- the provider adapters don't expose token counts.
//
// KNOWN LIMITATION (this suite): a citation like `html2pdf.js` recommending
// an external npm package (not a repo file) can still match the file-shaped
// regex below and get flagged "ungrounded" since it's not in the repo's
// file list. Distinguishing "invented repo file" from "real external
// package name" reliably needs a registry lookup this eval doesn't do.
// Basename matching (see isGrounded()) resolves the far more common false
// positive (prose shortening a real path on second reference); the
// remaining edge cases are rare and visible per-case in `explanation` for
// human review, which is what this harness is for.
//
// KNOWN LIMITATION (this suite): blastRadiusResult is a fixed placeholder
// ({file: null, count: 0}), not computed. blastRadius.js needs a real
// on-disk repo to walk (it reads file contents), and the fixture repos here
// are file-list-only (see repo-fixtures.json). This doesn't affect the
// grounding property under test -- blast radius numbers are prose context
// for the doc generator, not something this eval verifies.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDocs, SYSTEM } from '../src/pipeline/docGenerator.js';
import { classify } from '../src/pipeline/classifier.js';
import { estimate } from '../src/pipeline/estimate.js';
import { runEvalSuite } from './lib/harness.mjs';

// --- filled in for this flow -------------------------------------------------

async function loadCases() {
  const here = resolve(fileURLToPath(import.meta.url), '..');
  const edgeDir = join(here, 'edge-case-grounding');
  const cases = JSON.parse(readFileSync(join(edgeDir, 'cases.json'), 'utf8'));
  const repos = JSON.parse(readFileSync(join(edgeDir, 'repo-fixtures.json'), 'utf8'));

  return cases.map((c) => {
    // Real findings, reused from the edge-case-grounding suite's own baseline
    // run -- these are actual edgeCases.js output, not synthesized.
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

async function runCase(input, ctx) {
  // Real classifier() call (cheap, ~1 LLM call) so docGenerator sees
  // authentic open questions instead of a fabricated fixture.
  const openQuestions = await classify({
    description: input.description,
    contextText: input.contextText,
    answers: input.answers,
    findings: input.findings,
  });
  const blastRadiusResult = { file: null, count: 0 }; // see file header
  const estimateResult = estimate({ blastRadiusCount: blastRadiusResult.count, openQuestions });

  const { prdMarkdown, trdMarkdown } = await generateDocs({
    description: input.description,
    contextText: input.contextText,
    answers: input.answers,
    findings: input.findings,
    openQuestions,
    estimateResult,
    blastRadiusResult,
  });

  const answersText = input.answers
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.flagged === 'skip' ? '(skipped)' : a.answer}`)
    .join('\n\n');
  const findingsText = input.findings
    .map((f) => `- ${f.filePath || '(no file)'}: ${f.description} [confidence: ${f.confidence}, grounded: ${f.grounded}]`)
    .join('\n');
  const openQuestionsText = openQuestions.map((q) => `- [${q.category}] ${q.text}`).join('\n');
  const userPrompt = [
    `Feature request:\n${input.description}`,
    `Repo context:\n${input.contextText}`,
    `Clarifying Q&A:\n${answersText}`,
    `Edge-case findings:\n${findingsText}`,
    `Open questions:\n${openQuestionsText}`,
    `Estimate: ${estimateResult.low}-${estimateResult.high} days, up to ${estimateResult.worst} worst case.`,
    `Blast radius: ${blastRadiusResult.file || '(none identified)'} with ${blastRadiusResult.count} references.`,
  ].join('\n\n');

  return {
    output: JSON.stringify({ prdMarkdown, trdMarkdown }),
    transcript: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify({ prdMarkdown, trdMarkdown }, null, 2) },
    ],
    model: ctx.model || process.env[`${(process.env.LLM_PROVIDER || 'gemini').toUpperCase()}_MODEL`] || process.env.LLM_PROVIDER || 'unknown',
    prdMarkdown,
    trdMarkdown,
  };
}

// Matches backtick spans that look like a file path: a real file extension
// is REQUIRED (either after a slash, or bare) so this doesn't false-positive
// on URL routes like `/api`/`/health` or code patterns like `try/catch` --
// those have no dot-extension and are correctly left alone.
const FILE_LIKE = /`([\w.-]*\/[\w.-]+\.[a-z0-9]{1,6}|[\w-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|json|md|yml|yaml|go|rs|java|rb|php|css|scss|html|sql|toml|cfg|ini|sh|env|txt))`/gi;

function extractFileCitations(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(FILE_LIKE)) out.add(m[1]);
  return [...out];
}

// A citation counts as grounded if it matches a real path exactly, OR
// matches just the basename of a real path -- prose normally shortens
// `src/pipeline/coverageGate.js` to `coverageGate.js` on second reference,
// and that's normal technical writing, not a hallucination. Full-path
// matching alone (mirroring edgeCases.js's structured filePath field,
// exact-match is correct there) is too strict for free-form markdown.
function isGrounded(citation, files, basenames) {
  return files.includes(citation) || basenames.has(citation.split('/').pop());
}

async function gradeCase(input, run) {
  const basenames = new Set(input.files.map((f) => f.split('/').pop()));
  const citations = extractFileCitations(`${run.prdMarkdown}\n\n${run.trdMarkdown}`);
  const grounded = citations.filter((c) => isGrounded(c, input.files, basenames));

  return {
    grade: {
      // Headline metric, same shape as edge-case-grounding: did every
      // file-shaped backtick span in the doc cite a real file (by full path
      // or basename)?
      all_grounded: citations.length === 0 || grounded.length === citations.length ? 1 : 0,
      grounding_rate: citations.length === 0 ? 1 : grounded.length / citations.length,
      nonempty: run.prdMarkdown.trim().length > 0 && run.trdMarkdown.trim().length > 0 ? 1 : 0,
    },
    explanation: {
      all_grounded: `${grounded.length}/${citations.length} file-citing spans in PRD+TRD grounded in the real file list (full path or basename); ungrounded: ${JSON.stringify(citations.filter((c) => !isGrounded(c, input.files, basenames)))}`,
    },
  };
}

function perfFrom(run) {
  return {
    prd_chars: run.prdMarkdown.length,
    trd_chars: run.trdMarkdown.length,
  };
}

runEvalSuite({ scriptName: 'run-doc-eval.mjs', harnessSelfUrl: import.meta.url, loadCases, runCase, gradeCase, perfFrom });
