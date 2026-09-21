// Thin fetch wrapper over the existing, already-tested REST API
// (src/routes/sessions.js). Nothing about the backend pipeline changes for
// the chat UI -- these are the exact same endpoints the previous frontend used.

export interface ScanPill {
  label: string;
  tone: string;
}

export interface Question {
  id: string;
  seq: number;
  axis: string;
  question: string;
  groundedFile: string | null;
}

export interface StartSessionResponse {
  sessionId: string;
  repo: { label: string; scanPills: ScanPill[] };
  questions: Question[];
}

export interface AnswerInput {
  questionId: string;
  answer: string | null;
  flagged: 'skip' | 'vague' | null;
}

export interface OpenQuestion {
  category: 'PRODUCT_DECISION' | 'ENGINEERING_DECISION' | 'ASSUMPTION_MADE';
  text: string;
  source: string | null;
  confidence: string;
}

export interface AnswersResponse {
  sessionId: string;
  estimate: { low: number; high: number; worst: number };
  blastRadius: { file: string | null; count: number };
  prd: string;
  trd: string;
  openQuestions: OpenQuestion[];
  coverageGate: { passed: boolean; missing: string[] };
  grounded: string[];
  driving: string[];
}

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
}

export interface GithubWritebackError {
  title: string;
  message: string;
}

async function api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts?.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) {
    const message = (data as { error?: string })?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data as T;
}

export function startSession(input: { description: string; repoPath: string; githubPat?: string }) {
  return api<StartSessionResponse>('/sessions', { method: 'POST', body: input });
}

export function submitAnswers(sessionId: string, answers: AnswerInput[]) {
  return api<AnswersResponse>(`/sessions/${sessionId}/answers`, { method: 'POST', body: { answers } });
}

export function pushToGithub(sessionId: string, githubPat: string) {
  return api<{ issues: GithubIssue[]; errors: GithubWritebackError[] }>(`/sessions/${sessionId}/github`, {
    method: 'POST',
    body: { githubPat },
  });
}

export interface FsDir {
  name: string;
  path: string;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  dirs: FsDir[];
}

export function listDir(dirPath?: string) {
  const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  return api<FsListResponse>(`/fs/list${qs}`);
}
