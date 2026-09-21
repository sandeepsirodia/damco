import { startObservation } from '@langfuse/tracing';
import * as gemini from './gemini.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import { parseJson } from './parseJson.js';

// Model-agnostic LLM provider interface. Every adapter exports the same
// complete({ system, user, json }) -> Promise<string> shape, so swapping
// providers is a .env change (LLM_PROVIDER + that provider's API key),
// never a code change. Add a new provider by dropping in one more adapter
// file with this same shape and registering it below.
const PROVIDERS = { gemini, openai, anthropic };

export function getProvider(name = process.env.LLM_PROVIDER || 'gemini') {
  const key = name.toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(
      `Unknown LLM_PROVIDER "${name}". Supported: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }
  return provider;
}

// `name` labels the call by pipeline stage (e.g. "clarify", "edgeCases") so
// it's identifiable in Langfuse. Tracing is a no-op when no Langfuse SDK is
// registered (see src/tracing.js) -- OTel guarantees calls against an
// unregistered provider are safe, so callers never need to check for that.
export async function complete({ system, user, json = false, name = 'llm-call' }) {
  const provider = getProvider();
  const providerName = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const model = process.env[`${providerName.toUpperCase()}_MODEL`] || providerName;

  const generation = startObservation(
    name,
    { model, input: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    { asType: 'generation' }
  );
  try {
    const output = await provider.complete({ system, user, json });
    generation.update({ output });
    generation.end();
    return output;
  } catch (err) {
    generation.update({ level: 'ERROR', statusMessage: String(err?.message || err) });
    generation.end();
    throw err;
  }
}

export async function completeJson({ system, user, name }) {
  const text = await complete({ system, user, json: true, name });
  return parseJson(text);
}
