// Scripted conversations for the chat-agent eval (see ../../run-chat-eval.mjs).
// Each case is a fixed sequence of user turns run against the REAL
// INSTRUCTIONS/TOOLS from web/src/lib/chatAgent.js through the REAL
// BuiltInAgent -- only the tool *execution* is stubbed (no live backend/DB/repo
// scan), so these are fast and cheap while still exercising the actual prompt.
//
// Targets exactly the two behaviors shipped in this session: (1) don't
// re-ask for a repo path that's already selected via the header picker, and
// (2) the fixed ✅ Answered / ❓ Remaining template on a partial reply, with a
// real submitFeatureAnswers call once everything is covered.

const REPO_PATH = '/Users/sandeep/assignment/damco';

// A realistic startFeatureSpec result: 4 fixed axes + 1 repo-finding
// question, matching clarify.js's actual contract (see FIXED_AXES).
const STUB_QUESTIONS = [
  { questionId: 'q1', axis: 'user-facing behavior', question: 'Should the rate limit apply per-user or per-IP when the request is unauthenticated?', groundedFile: null },
  { questionId: 'q2', axis: 'data model impact', question: 'Do we need a new table to track request counts, or can this live in Redis/in-memory only?', groundedFile: null },
  { questionId: 'q3', axis: 'who is affected', question: 'Should this apply to all API routes, or only the /api/sessions endpoints?', groundedFile: null },
  { questionId: 'q4', axis: 'explicit out-of-scope', question: 'Is a configurable per-plan rate limit (free vs paid tier) out of scope for this first pass?', groundedFile: null },
  { questionId: 'q5', axis: 'repo finding', question: 'src/routes/sessions.js has no existing middleware layer -- should the limiter be added there directly, or wired via app.use() in server.js?', groundedFile: 'src/routes/sessions.js' },
];

const startFeatureSpecStub = () => ({
  sessionId: 'sess-eval-1',
  repoScan: '42 files scanned, README.md found, Node/Express',
  questions: STUB_QUESTIONS,
});

const submitFeatureAnswersStub = () => ({
  sessionId: 'sess-eval-1',
  estimate: { low: 2, high: 4, worst: 6 },
  blastRadius: { file: 'src/routes/sessions.js', count: 3 },
  prd: '# PRD (stub)',
  trd: '# TRD (stub)',
  openQuestions: [],
  coverageGate: { passed: true, missing: [] },
  grounded: ['src/routes/sessions.js'],
  driving: [],
});

const STUBS = { startFeatureSpec: startFeatureSpecStub, submitFeatureAnswers: submitFeatureAnswersStub, pushToGithub: () => ({ issues: [] }) };

function toolCall(outcome, name) {
  return outcome.toolCalls.find((c) => c.name === name) ?? null;
}

export const cases = [
  {
    id: 'repo-path-prefilled-no-reask',
    context: [{ description: 'Selected repo path (from the Browse control in the header, may be empty)', value: JSON.stringify(REPO_PATH) }],
    stubs: STUBS,
    steps: [
      {
        user: 'Spec a per-user rate limiter for the Express routes.',
        checks: {
          calls_start_feature_spec: (o) => !!toolCall(o, 'startFeatureSpec'),
          repo_path_matches_context: (o) => toolCall(o, 'startFeatureSpec')?.args?.repoPath === REPO_PATH,
          no_repo_path_question_first: (o) => !/which repo|what.*(repo path|repository)|provide.*(repo|path)/i.test(o.textBeforeFirstToolCall),
        },
      },
    ],
  },
  {
    id: 'repo-path-empty-should-ask',
    context: [{ description: 'Selected repo path (from the Browse control in the header, may be empty)', value: JSON.stringify('') }],
    stubs: STUBS,
    steps: [
      {
        user: 'Spec a per-user rate limiter for the Express routes.',
        checks: {
          no_tool_call_yet: (o) => o.toolCalls.length === 0,
          asks_for_repo_path: (o) => /\?/.test(o.finalText) && /repo|path|url/i.test(o.finalText),
        },
      },
    ],
  },
  {
    id: 'partial-answer-template-then-skip-submits',
    context: [{ description: 'Selected repo path (from the Browse control in the header, may be empty)', value: JSON.stringify(REPO_PATH) }],
    stubs: STUBS,
    steps: [
      {
        user: 'Spec a per-user rate limiter for the Express routes.',
        checks: { calls_start_feature_spec: (o) => !!toolCall(o, 'startFeatureSpec') },
      },
      {
        // Answers only questions 1 and 3 -- a genuinely partial reply.
        user: '1. Per-user, anonymous requests should just be blocked. 3. Just the /api/sessions endpoints for now.',
        checks: {
          no_submit_yet: (o) => !toolCall(o, 'submitFeatureAnswers'),
          template_answered_count: (o) => /✅\s*Answered\s*\(2\s*\/\s*5\)/.test(o.finalText),
          template_remaining_count: (o) => /❓\s*Remaining\s*\(3\s*\/\s*5\)/.test(o.finalText),
        },
      },
      {
        user: 'skip the rest',
        checks: {
          calls_submit: (o) => !!toolCall(o, 'submitFeatureAnswers'),
          all_five_present: (o) => (toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? []).length === 5,
          q1_answered_not_skipped: (o) => {
            const a = (toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? []).find((x) => x.questionId === 'q1');
            return !!a && a.flagged !== 'skip' && !!a.answer;
          },
          q3_answered_not_skipped: (o) => {
            const a = (toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? []).find((x) => x.questionId === 'q3');
            return !!a && a.flagged !== 'skip' && !!a.answer;
          },
          q2_q4_q5_flagged_skip: (o) => {
            const answers = toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? [];
            return ['q2', 'q4', 'q5'].every((id) => answers.find((x) => x.questionId === id)?.flagged === 'skip');
          },
        },
      },
    ],
  },
  {
    id: 'full-answers-no-template-needed',
    context: [{ description: 'Selected repo path (from the Browse control in the header, may be empty)', value: JSON.stringify(REPO_PATH) }],
    stubs: STUBS,
    steps: [
      {
        user: 'Spec a per-user rate limiter for the Express routes.',
        checks: { calls_start_feature_spec: (o) => !!toolCall(o, 'startFeatureSpec') },
      },
      {
        user:
          '1. Per-user. 2. Redis only, no new table needed. 3. All API routes, not just sessions. ' +
          '4. Yes, per-plan tiers are out of scope for now. 5. Add it directly in sessions.js as middleware.',
        checks: {
          // Everything was covered in one message -- should go straight to
          // submitFeatureAnswers, not stall on the partial-answer template.
          calls_submit_directly: (o) => !!toolCall(o, 'submitFeatureAnswers'),
          all_five_present: (o) => (toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? []).length === 5,
          none_flagged_skip: (o) => (toolCall(o, 'submitFeatureAnswers')?.args?.answers ?? []).every((a) => a.flagged !== 'skip'),
        },
      },
    ],
  },
];
