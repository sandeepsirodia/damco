import { CopilotRuntime, BuiltInAgent, createCopilotExpressHandler } from '@copilotkit/runtime/v2';

// Reuses the exact same LLM_PROVIDER / <PROVIDER>_MODEL / <PROVIDER>_API_KEY
// env vars as src/llm/index.js, so switching providers for the chat layer is
// still a .env edit, never a code change -- same promise as the pipeline's
// own model-agnostic design. BuiltInAgent's model string uses "google" for
// Gemini rather than our own "gemini" provider name, so that's mapped below;
// the apiKey is always passed explicitly rather than relying on BuiltInAgent's
// default env var names (which don't match ours for Gemini: GOOGLE_API_KEY vs
// our GEMINI_API_KEY).
export function buildAgent() {
  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

  const byProvider = {
    openai: { agentProvider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-6-astra', apiKey: process.env.OPENAI_API_KEY },
    anthropic: { agentProvider: 'anthropic', model: process.env.ANTHROPIC_MODEL || 'claude-opus-5', apiKey: process.env.ANTHROPIC_API_KEY },
    gemini: { agentProvider: 'google', model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', apiKey: process.env.GEMINI_API_KEY },
  };

  const config = byProvider[provider];
  if (!config) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}" for the chat runtime. Supported: gemini, openai, anthropic`);
  }

  return new BuiltInAgent({
    model: `${config.agentProvider}/${config.model}`,
    apiKey: config.apiKey,
    prompt: 'You are a concise conversational front door for a repo-aware feature-spec tool. Follow the additional instructions the frontend provides.',
  });
}

// Mounts the CopilotKit chat runtime. This powers only the conversational
// routing (deciding when to call the frontend's runFeatureSpec action) -- the
// actual pipeline work (repo read, clarify, grounding, PRD/TRD) still runs
// entirely through the existing REST API in src/routes/sessions.js, unchanged.
export function mountCopilotKit(app) {
  const runtime = new CopilotRuntime({ agents: { default: buildAgent() } });

  app.use(
    createCopilotExpressHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: true,
    })
  );
}
