import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TEXT_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rb', '.java', '.php']);
const MAX_FILES_SCANNED = 1000;
const MAX_FILE_BYTES = 200_000;
const IMPORT_TARGET = /(?:from|require\()\s*['"`]([^'"`]+)['"`]/g;

function basenameNoExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Single pass over every code file, tallying how many times each basename
 * (of every import/require target) is referenced elsewhere in the repo.
 * O(n) file reads instead of grepping every file against every candidate.
 */
async function buildReferenceTally(rootDir, codeFiles) {
  const tally = new Map();
  for (const f of codeFiles.slice(0, MAX_FILES_SCANNED)) {
    let buf;
    try {
      buf = await readFile(path.join(rootDir, f), 'utf8');
    } catch {
      continue; // unreadable (binary, permission) -- heuristic, not a hard guarantee
    }
    if (buf.length > MAX_FILE_BYTES) continue;
    for (const match of buf.matchAll(IMPORT_TARGET)) {
      const target = basenameNoExt(match[1]);
      tally.set(target, (tally.get(target) || 0) + 1);
    }
  }
  return tally;
}

/**
 * Stage 3: Blast-Radius Heuristic. Reference-count stand-in for a real
 * dependency graph (madge/dependency-cruiser is the designed-but-not-built
 * upgrade path).
 */
export async function blastRadius({ rootDir, files, groundedFile }) {
  // A missing rootDir (GitHub-URL clone cleaned up, or a stale session)
  // would otherwise make every per-file read fail silently, indistinguishable
  // from a repo that genuinely has zero references -- fail loudly instead.
  if (!existsSync(rootDir)) {
    throw new Error(`Repo directory no longer exists: ${rootDir} (may have been cleaned up since the session started)`);
  }

  const codeFiles = files.filter((f) => TEXT_EXT.has(path.extname(f)));
  if (codeFiles.length === 0) return { file: null, count: 0 };

  const tally = await buildReferenceTally(rootDir, codeFiles);

  if (groundedFile && codeFiles.includes(groundedFile)) {
    return { file: groundedFile, count: tally.get(basenameNoExt(groundedFile)) || 0 };
  }

  // No anchor from the clarify stage -- fall back to whichever file is
  // referenced the most across the repo.
  let best = { file: null, count: -1 };
  for (const f of codeFiles) {
    const count = tally.get(basenameNoExt(f)) || 0;
    if (count > best.count) best = { file: f, count };
  }
  return best.file ? best : { file: null, count: 0 };
}
