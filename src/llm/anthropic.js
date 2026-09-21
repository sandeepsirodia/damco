const DEFAULT_MODEL = 'claude-opus-5';

export async function complete({ system, user, json = false }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (LLM_PROVIDER=anthropic)');
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  // Anthropic's Messages API has no dedicated JSON-mode flag (unlike OpenAI/Gemini) --
  // enforce it via an explicit system instruction instead; parseJson() strips any
  // stray ```json fence as a safety net if the model wraps its output anyway.
  const systemPrompt = json
    ? `${system}\n\nRespond with ONLY valid JSON. No prose, no markdown code fences.`
    : system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.4,
      system: systemPrompt,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content?.map((b) => b.text ?? '').join('') ?? '';
  if (!text) throw new Error(`Anthropic returned no content: ${JSON.stringify(data).slice(0, 300)}`);
  return text;
}
