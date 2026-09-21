import { readFile, readdir, mkdtemp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ignore from 'ignore';

const execFileAsync = promisify(execFile);

const BASELINE_IGNORE = ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor'];
const MANIFESTS = [
  { file: 'package.json', label: 'Node' },
  { file: 'requirements.txt', label: 'Python' },
  { file: 'pyproject.toml', label: 'Python' },
  { file: 'go.mod', label: 'Go' },
  { file: 'Cargo.toml', label: 'Rust' },
  { file: 'pom.xml', label: 'Java' },
];

function isGitUrl(repoPath) {
  return /^https?:\/\//.test(repoPath) || repoPath.startsWith('git@');
}

async function cloneToTemp(repoUrl, githubPat) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spec-clarity-'));
  let cloneUrl = repoUrl;
  if (githubPat && repoUrl.startsWith('https://')) {
    cloneUrl = repoUrl.replace('https://', `https://x-access-token:${githubPat}@`);
  }
  try {
    await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, dir]);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('git is not available on the server, so a GitHub URL cannot be cloned. Use a local repo path instead.');
    }
    const reason = (err.stderr || err.message || '').trim().split('\n').pop();
    throw new Error(`Could not clone ${repoUrl}: ${reason || 'unknown git error'}. Check the URL and, for a private repo, provide a PAT.`);
  }
  return dir;
}

async function walk(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const ig = ignore().add(BASELINE_IGNORE);
  if (existsSync(gitignorePath)) {
    ig.add(await readFile(gitignorePath, 'utf8'));
  }

  const files = [];
  async function recurse(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs);
      if (ig.ignores(rel) || ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
      if (entry.isDirectory()) {
        await recurse(abs);
      } else {
        files.push(rel);
      }
    }
  }
  await recurse(rootDir);
  return files;
}

async function readReadme(rootDir, files) {
  const readme = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f));
  if (!readme) return null;
  const content = await readFile(path.join(rootDir, readme), 'utf8');
  return content.slice(0, 4000);
}

async function detectManifest(rootDir, files) {
  for (const { file, label } of MANIFESTS) {
    if (files.includes(file)) {
      const content = await readFile(path.join(rootDir, file), 'utf8');
      return { file, label, content: content.slice(0, 2000) };
    }
  }
  return null;
}

function detectStackLabel(manifest) {
  if (!manifest) return 'Unknown stack';
  if (manifest.file === 'package.json') {
    try {
      const pkg = JSON.parse(manifest.content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.express) return 'Node/Express';
      if (deps.next) return 'Node/Next.js';
      if (deps.react) return 'Node/React';
      return 'Node.js';
    } catch {
      return 'Node.js';
    }
  }
  if (manifest.file === 'requirements.txt' || manifest.file === 'pyproject.toml') {
    if (/django/i.test(manifest.content)) return 'Python/Django';
    if (/flask/i.test(manifest.content)) return 'Python/Flask';
    return 'Python';
  }
  return manifest.label;
}

/**
 * Stage 1: Repo Context Reader.
 * Walks the repo (gitignore-aware), pulls README + manifest, produces a
 * compact text summary for grounding later LLM calls -- no embeddings.
 */
export async function readRepo({ repoPath, githubPat }) {
  let rootDir = repoPath;
  let cleanup = null;
  if (isGitUrl(repoPath)) {
    rootDir = await cloneToTemp(repoPath, githubPat);
    cleanup = rootDir;
  } else if (!existsSync(repoPath)) {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  } else if (!(await stat(repoPath)).isDirectory()) {
    throw new Error(`Repo path is not a directory: ${repoPath}`);
  }

  const files = await walk(rootDir);
  const readme = await readReadme(rootDir, files);
  const manifest = await detectManifest(rootDir, files);
  const stackLabel = detectStackLabel(manifest);

  const scanPills = [
    { label: `${files.length} files scanned`, tone: 'muted' },
    ...(readme ? [{ label: 'README.md found', tone: 'success' }] : [{ label: 'No README found', tone: 'muted' }]),
    ...(manifest ? [{ label: `${manifest.file} found`, tone: 'success' }] : []),
    { label: stackLabel, tone: 'primary' },
  ];

  const contextText = [
    `Repo file list (${files.length} files):`,
    files.slice(0, 300).join('\n'),
    readme ? `\nREADME excerpt:\n${readme}` : '',
    manifest ? `\n${manifest.file} excerpt:\n${manifest.content}` : '',
  ].join('\n');

  return { rootDir, cleanup, files, readme, manifest, stackLabel, scanPills, contextText };
}
