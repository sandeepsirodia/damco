// LLMs occasionally wrap JSON in a ```json fence, or add prose around it,
// even when asked not to. Try progressively looser recovery before failing
// the whole pipeline stage.
export function parseJson(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence/prose recovery below
  }

  // A fence anywhere in the text, not just wrapping the whole string --
  // e.g. "Here is the JSON:\n```json\n[...]\n```" isn't caught by an
  // anchored ^...$ match.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }

  // Last resort: no fence at all, just prose wrapped around raw JSON --
  // take the outermost [...] or {...} span.
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through to the error below
    }
  }

  throw new Error(`LLM did not return valid JSON:\n---\n${text.slice(0, 500)}`);
}
