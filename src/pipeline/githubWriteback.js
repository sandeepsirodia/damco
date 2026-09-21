const GITHUB_URL_RE = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/;

/**
 * Stage 9: GitHub Write-back. Only runs if a PAT was supplied to this
 * request -- the PAT is used in-memory for this call only and is never
 * persisted to the database or disk.
 */
export async function githubWriteback({ repoPath, githubPat, openQuestions, resTitle }) {
  if (!githubPat) throw new Error('No GitHub PAT supplied -- write-back is opt-in per request');

  const match = repoPath.match(GITHUB_URL_RE);
  if (!match) throw new Error('GitHub write-back requires repoPath to be a github.com repo URL');
  const [, owner, repo] = match;

  const issues = [];
  const errors = [];
  for (const q of openQuestions) {
    const title = `[${q.category}] ${q.text.slice(0, 80)}`;
    const body = [
      resTitle ? `Feature: ${resTitle}` : null,
      `Category: ${q.category}`,
      q.source ? `Source: ${q.source}` : null,
      q.confidence ? `Confidence: ${q.confidence}` : null,
      '',
      q.text,
    ]
      .filter(Boolean)
      .join('\n');

    // Per-issue try/catch, not a throw that aborts the loop: a single
    // failure (e.g. a rate limit on issue 3 of 5) used to lose the issues
    // already created for 1-2 -- never returned, never persisted, and a
    // retry would then duplicate them. Keep going and report what failed.
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${githubPat}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title, body }),
      });

      if (!res.ok) {
        throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
      }
      const data = await res.json();
      issues.push({ number: data.number, title: data.title, url: data.html_url });
    } catch (err) {
      errors.push({ title, message: err.message });
    }
  }

  return { issues, errors };
}
