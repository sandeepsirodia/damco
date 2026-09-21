#!/usr/bin/env node
// Eval runner for the CopilotKit chat-agent layer (src/copilotkit.js +
// web/src/lib/chatAgent.js's INSTRUCTIONS/TOOLS) -- the conversational
// orchestration that decides WHEN to call startFeatureSpec/submitFeatureAnswers
// and what to say in between. None of the other 3 eval suites touch this: they
// call clarify.js/edgeCases.js/classifier.js/docGenerator.js directly as
// functions, bypassing the chat layer entirely.
//
//   node eval/run-chat-eval.mjs --approve-harness
//
// HOW: drives the real BuiltInAgent (the exact class + buildAgent() config
// src/copilotkit.js uses for the live /api/copilotkit endpoint) directly via
// its .run(RunAgentInput) Observable -- no HTTP, no browser. This is the same
// AG-UI protocol a real browser client speaks; the eval plays the "client"
// role itself: when the model emits a tool call, the eval executes a STUB
// (see eval/chat-agent/cases.mjs) instead of hitting the real REST API, feeds
// the stub result back as a tool-role message, and re-runs -- exactly the
// round-trip a browser would do, just without a browser or a real backend
// call. Tool schemas come from actionParametersToJsonSchema() (real
// @copilotkit/shared code, not a hand-rolled JSON Schema guess).
//
// WHY STUBBED TOOL EXECUTION: the property under test is the AGENT'S
// decisions (which tool, what args, what it says on a partial reply) -- not
// the REST pipeline those tools call, which the other 3 suites + tests/
// already cover. Stubbing keeps this suite fast and independent of a running
// docker container / Postgres / real repo scan.
//
// GRADING: every check in eval/chat-agent/cases.mjs is a deterministic
// predicate (tool name, arg shape, or a literal regex on the response text)
// -- no LLM judge anywhere in this suite. Unlike question-quality's judge
// dimensions, "did it call submitFeatureAnswers with 5 answers" or "does the
// text contain '✅ Answered (2/5)'" has no subjective edge, so there's no
// same-model-bias risk to caveat here.
//
// KNOWN LIMITATION: this eval constructs `context` entries directly (bypassing
// the actual useCopilotReadable/useCopilotAdditionalInstructions React hooks),
// verified to reach the model the same way (see PR notes / session history) --
// but it does NOT exercise CopilotKit's own client-side wire encoding, so a
// regression specific to that plumbing (not this app's prompt/tool content)
// would not be caught here. That's a third-party library concern already
// covered by CopilotKit's own tests, not this app's.

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuiltInAgent } from '@copilotkit/runtime/v2';
import { actionParametersToJsonSchema } from '@copilotkit/shared';
import { buildAgent } from '../src/copilotkit.js';
import { INSTRUCTIONS, TOOLS } from '../web/src/lib/chatAgent.js';
import { cases } from './chat-agent/cases.mjs';

const FLOW_DIR = resolve(fileURLToPath(import.meta.url), '..', 'chat-agent');
const VARIANT_DIR = join(FLOW_DIR, 'baseline');
const RESULTS_PATH = join(VARIANT_DIR, 'results.jsonl');
const STATE_PATH = join(FLOW_DIR, '_state.json');

// AG-UI tool declarations, generated from the SAME TOOLS object App.tsx
// registers with useCopilotAction -- via the same converter CopilotKit's own
// client uses internally, so this can't silently diverge from the real schema.
const AGUI_TOOLS = Object.entries(TOOLS).map(([name, t]) => ({
  name,
  description: t.description,
  parameters: actionParametersToJsonSchema(t.parameters),
}));

const BASE_CONTEXT = [{ description: 'System instructions for this conversation', value: INSTRUCTIONS }];

// --- harness integrity (same principle as the other 3 suites: this file +
// cases.mjs together ARE the grading logic, so editing either requires a
// reviewed --approve-harness once; chatAgent.js is product code under test,
// deliberately NOT hashed here, same as edgeCases.js isn't hashed by
// run-eval.mjs) ------------------------------------------------------------

function checkHarness(approve) {
  const self = fileURLToPath(import.meta.url);
  const casesFile = resolve(FLOW_DIR, 'cases.mjs');
  const h = createHash('sha256');
  for (const p of [self, casesFile].sort()) {
    h.update(relative(process.cwd(), p)).update('\0').update(readFileSync(p)).update('\0');
  }
  const sha = h.digest('hex');
  let st = {};
  if (existsSync(STATE_PATH)) {
    try { st = JSON.parse(readFileSync(STATE_PATH, 'utf8')) || {}; }
    catch (e) { console.error(`${STATE_PATH} exists but is not valid JSON (${e?.message || e})`); process.exit(2); }
  }
  if (st.harness_sha === sha) return;
  if (approve) {
    st.harness_sha = sha;
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2) + '\n');
    console.error(`harness approved: sha256 ${sha.slice(0, 12)} over run-chat-eval.mjs + chat-agent/cases.mjs`);
    return;
  }
  if (st.harness_sha == null) {
    console.error(`no approved harness sha in ${STATE_PATH} (computed ${sha.slice(0, 12)}).`);
  } else {
    console.error(`harness changed since last approved run; approved ${String(st.harness_sha).slice(0, 12)}, now ${sha.slice(0, 12)}.`);
  }
  console.error('Review the diff, then re-run with --approve-harness.');
  process.exit(2);
}

// --- driving BuiltInAgent directly (no HTTP, no browser) -------------------

// A fresh BuiltInAgent per call -- instances aren't safely reusable for a
// second .run() ("Agent is already running"), and each of our rounds is
// logically an independent request anyway (the full conversation lives in
// `messages`, not agent state).
function runRound(input) {
  return new Promise((res, reject) => {
    let text = '';
    const acc = new Map();
    const toolCalls = [];
    let finishReason = null;
    buildAgent().run(input).subscribe({
      next: (ev) => {
        if (ev.type === 'TEXT_MESSAGE_CHUNK') text += ev.delta ?? '';
        else if (ev.type === 'TOOL_CALL_START') acc.set(ev.toolCallId, { name: ev.toolCallName, argsText: '' });
        else if (ev.type === 'TOOL_CALL_ARGS') { const t = acc.get(ev.toolCallId); if (t) t.argsText += ev.delta ?? ''; }
        else if (ev.type === 'TOOL_CALL_END') {
          const t = acc.get(ev.toolCallId);
          if (t) {
            let args;
            try { args = t.argsText ? JSON.parse(t.argsText) : {}; }
            catch (e) { args = { __parse_error: String(e?.message || e), raw: t.argsText }; }
            toolCalls.push({ id: ev.toolCallId, name: t.name, args });
          }
        } else if (ev.type === 'RUN_FINISHED') finishReason = ev.finishReason ?? null;
        else if (ev.type === 'RUN_ERROR') reject(new Error(`RUN_ERROR: ${ev.message || JSON.stringify(ev)}`));
      },
      error: reject,
      complete: () => res({ text, toolCalls, finishReason }),
    });
  });
}

// Runs one user turn to completion: repeats agent.run() while the model keeps
// calling tools (resolving each via the case's stubs and feeding the result
// back), stopping at the first round with no tool call -- that terminal
// round's text is what a real chat UI would actually show the user.
async function runStep(threadId, messages, context, userText, stubs) {
  messages.push({ id: randomUUID(), role: 'user', content: userText });
  const rounds = [];
  const toolCallsInStep = [];
  for (let guard = 0; guard < 6; guard++) {
    const round = await runRound({ threadId, runId: randomUUID(), state: {}, messages, tools: AGUI_TOOLS, context });
    rounds.push(round);
    if (round.toolCalls.length === 0) break;
    messages.push({
      id: randomUUID(), role: 'assistant', content: round.text || '',
      toolCalls: round.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
    });
    for (const tc of round.toolCalls) {
      const stub = stubs[tc.name];
      const result = stub ? await stub(tc.args) : { error: true, message: `no stub registered for tool "${tc.name}"` };
      messages.push({ id: randomUUID(), role: 'tool', content: JSON.stringify(result), toolCallId: tc.id });
      toolCallsInStep.push(tc);
    }
  }
  let textBeforeFirstToolCall = '';
  for (const r of rounds) {
    textBeforeFirstToolCall += r.text ?? '';
    if (r.toolCalls.length > 0) break;
  }
  const finalText = rounds[rounds.length - 1]?.text ?? '';
  // Record the terminal text-only round as a real assistant message too --
  // that's what a chat UI would actually persist as "what the user saw".
  if (finalText) messages.push({ id: randomUUID(), role: 'assistant', content: finalText });
  return { toolCalls: toolCallsInStep, finalText, textBeforeFirstToolCall, rounds: rounds.length };
}

async function runCase(c) {
  const threadId = randomUUID();
  const messages = [];
  const stepResults = [];
  for (const step of c.steps) {
    const outcome = await runStep(threadId, messages, [...BASE_CONTEXT, ...c.context], step.user, c.stubs);
    const grade = {};
    const explanation = {};
    for (const [name, fn] of Object.entries(step.checks)) {
      let pass = false, err = null;
      try { pass = !!fn(outcome); } catch (e) { err = e; }
      grade[name] = pass ? 1 : 0;
      explanation[name] = err
        ? `threw: ${err.message}`
        : pass ? 'ok' : `failed -- toolCalls=${JSON.stringify(outcome.toolCalls.map((t) => ({ name: t.name, args: t.args })))} finalText=${JSON.stringify(outcome.finalText.slice(0, 300))}`;
    }
    stepResults.push({ user: step.user, grade, explanation });
  }
  return { stepResults, messages };
}

async function main() {
  const approveHarness = process.argv.includes('--approve-harness');
  checkHarness(approveHarness);

  const tracesDir = join(VARIANT_DIR, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  if (existsSync(RESULTS_PATH)) writeFileSync(RESULTS_PATH, '');

  let okChecks = 0, failChecks = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let stepResults, messages;
    try {
      ({ stepResults, messages } = await runCase(c));
      writeFileSync(join(tracesDir, `${c.id}.json`), JSON.stringify(messages, null, 2));
    } catch (e) {
      failChecks++;
      appendFileSync(RESULTS_PATH, JSON.stringify({ case_id: c.id, error: String(e?.message || e) }) + '\n');
      console.error(`[chat-agent] ${c.id} FAILED (threw): ${e?.message || e}`);
      continue;
    }
    const latency_s = (Date.now() - t0) / 1000;
    for (let i = 0; i < stepResults.length; i++) {
      const sr = stepResults[i];
      const row = { case_id: c.id, step: i, user: sr.user, latency_s: i === stepResults.length - 1 ? latency_s : undefined, grade: sr.grade, explanation: sr.explanation };
      appendFileSync(RESULTS_PATH, JSON.stringify(row) + '\n');
      for (const [name, v] of Object.entries(sr.grade)) {
        if (v === 1) okChecks++;
        else { failChecks++; console.error(`  [chat-agent] ${c.id} step${i} FAILED check '${name}': ${sr.explanation[name]}`); }
      }
    }
    console.error(`[chat-agent] ${c.id} done in ${latency_s.toFixed(1)}s`);
  }

  console.error(`[chat-agent] done -- ${okChecks} checks passed, ${failChecks} failed -> ${RESULTS_PATH}`);
  process.exit(failChecks ? 1 : 0);
}

main();
