CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  repo_scan JSONB,
  status TEXT NOT NULL DEFAULT 'clarifying',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INT NOT NULL,
  axis TEXT NOT NULL,
  question TEXT NOT NULL,
  grounded_file TEXT,
  answer TEXT,
  flagged TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT,
  description TEXT NOT NULL,
  grounded BOOLEAN NOT NULL DEFAULT false,
  confidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS open_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  confidence TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  prd_markdown TEXT,
  trd_markdown TEXT,
  estimate_low NUMERIC,
  estimate_high NUMERIC,
  estimate_worst NUMERIC,
  blast_radius_file TEXT,
  blast_radius_count INT,
  coverage_passed BOOLEAN,
  coverage_missing JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  number INT,
  title TEXT,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
