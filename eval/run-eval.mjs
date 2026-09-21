#!/usr/bin/env node
// Eval runner for the "Edge Case & Dependency Agent" flow (src/pipeline/edgeCases.js).
// Measures the app's core promise: every finding must cite a real repo file,
// or be correctly marked ungrounded -- never a hallucinated path presented as real.
//
//   node eval/run-eval.mjs --flow eval/edge-case-grounding --variant baseline --approve-harness
//
// The harness itself (CLI parsing, resume, backoff, wall-clock ceiling,
// harness-integrity gate, worker loop) lives in eval/lib/harness.mjs, shared
// with run-doc-eval.mjs and run-question-eval.mjs -- this file only supplies
// what's specific to this suite below.
//
// KNOWN LIMITATION: the LLM provider adapters (src/llm/*.js) return only the
// completion text, not token usage -- so `usage` and `cost_usd` are omitted
// here rather than faked. Wiring usage through would touch every pipeline
// stage's call signature; out of scope for building this eval. See the
// handover notes.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edgeCases, SYSTEM } from '../src/pipeline/edgeCases.js';
import { runEvalSuite } from './lib/harness.mjs';

// --- filled in for this flow -------------------------------------------------

async function loadCases() {
  const here = resolve(fileURLToPath(import.meta.url), '..');
  const cases = JSON.parse(readFileSync(join(here, 'edge-case-grounding', 'cases.json'), 'utf8'));
  const repos = JSON.parse(readFileSync(join(here, 'edge-case-grounding', 'repo-fixtures.json'), 'utf8'));
  return cases.map((c) => ({
    id: c.id,
    tags: c.tags,
    description: c.description,
    answers: c.answers,
    files: repos[c.repo].files,
    contextText: repos[c.repo].contextText,
  }));
}

async function runCase(input, ctx) {
  const findings = await edgeCases({
    description: input.description,
    contextText: input.contextText,
    answers: input.answers,
    files: input.files,
  });

  const answersText = input.answers
    .map((a) => `Q (${a.axis}): ${a.question}\nA: ${a.flagged === 'skip' ? '(skipped)' : a.answer}`)
    .join('\n\n');
  const userPrompt = `Feature request:\n${input.description}\n\nRepo context:\n${input.contextText}\n\nClarifying Q&A:\n${answersText}`;

  return {
    output: JSON.stringify(findings, null, 2),
    transcript: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(findings, null, 2) },
    ],
    model: ctx.model || process.env[`${(process.env.LLM_PROVIDER || 'gemini').toUpperCase()}_MODEL`] || process.env.LLM_PROVIDER || 'unknown',
    // usage intentionally omitted -- see file header. stop_reason not
    // surfaced by the provider adapters either.
    findings,
  };
}

async function gradeCase(input, run) {
  const findings = run.findings;
  const totalFindings = findings.length;
  const findingsWithFile = findings.filter((f) => f.filePath).length;
  const groundedFindings = findings.filter((f) => f.grounded).length;

  // Sanity-check the app's own grounding computation against the real file
  // list -- this eval doubles as a regression test of edgeCases.js itself,
  // not just the model's behavior.
  const recomputedGrounded = findings.filter((f) => f.filePath && input.files.includes(f.filePath)).length;
  if (recomputedGrounded !== groundedFindings) {
    throw new Error(
      `grounded-flag mismatch: app reported ${groundedFindings}, recomputed ${recomputedGrounded} -- edgeCases.js grounding logic may have regressed`
    );
  }

  return {
    grade: {
      // First = headline metric: did every file-citing finding cite a real file?
      all_grounded: findingsWithFile === 0 || groundedFindings === findingsWithFile ? 1 : 0,
      grounding_rate: findingsWithFile === 0 ? 1 : groundedFindings / findingsWithFile,
      nonempty: totalFindings > 0 ? 1 : 0,
    },
    explanation: {
      all_grounded: `${groundedFindings}/${findingsWithFile} file-citing findings grounded in the real file list`,
    },
  };
}

function perfFrom(run) {
  return {
    total_findings: run.findings.length,
    findings_with_file: run.findings.filter((f) => f.filePath).length,
  };
}

runEvalSuite({ scriptName: 'run-eval.mjs', harnessSelfUrl: import.meta.url, loadCases, runCase, gradeCase, perfFrom });
