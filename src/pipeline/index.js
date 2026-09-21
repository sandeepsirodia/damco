import { readRepo } from './repoReader.js';
import { clarify } from './clarify.js';
import { blastRadius } from './blastRadius.js';
import { edgeCases } from './edgeCases.js';
import { classify } from './classifier.js';
import { estimate } from './estimate.js';
import { generateDocs } from './docGenerator.js';
import { coverageGate } from './coverageGate.js';
import { githubWriteback } from './githubWriteback.js';

/** Stages 1-2: repo scan + clarifying questions, run when a session starts. */
export async function runIntake({ description, repoPath, githubPat }) {
  const repo = await readRepo({ repoPath, githubPat });
  const questions = await clarify({ description, contextText: repo.contextText, files: repo.files });
  return { repo, questions };
}

/** Stages 3-8: everything from blast radius through the coverage gate, run once answers are in. */
export async function runAnalysis({ description, repo, answers }) {
  const groundedFile = answers.find((a) => a.groundedFile)?.groundedFile || null;

  const blastRadiusResult = await blastRadius({ rootDir: repo.rootDir, files: repo.files, groundedFile });
  const findings = await edgeCases({ description, contextText: repo.contextText, answers, files: repo.files });
  const openQuestions = await classify({ description, contextText: repo.contextText, answers, findings });
  const estimateResult = estimate({ blastRadiusCount: blastRadiusResult.count, openQuestions });
  const { prdMarkdown, trdMarkdown } = await generateDocs({
    description,
    contextText: repo.contextText,
    answers,
    findings,
    openQuestions,
    estimateResult,
    blastRadiusResult,
  });
  const coverage = coverageGate({ findings, prdMarkdown, trdMarkdown });

  return { blastRadiusResult, findings, openQuestions, estimateResult, prdMarkdown, trdMarkdown, coverage };
}

/** Stage 9: opt-in GitHub write-back. */
export async function runGithubWriteback({ repoPath, githubPat, openQuestions, resTitle }) {
  return githubWriteback({ repoPath, githubPat, openQuestions, resTitle });
}
