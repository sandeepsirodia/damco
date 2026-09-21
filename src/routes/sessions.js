import { Router } from 'express';
import { rm } from 'node:fs/promises';
import { startActiveObservation } from '@langfuse/tracing';
import { query } from '../db/index.js';
import { runIntake, runAnalysis, runGithubWriteback } from '../pipeline/index.js';

export const router = Router();

function shapeSession(row) {
  return {
    sessionId: row.id,
    description: row.description,
    repoPath: row.repo_path,
    repo: { label: shortRepoLabel(row.repo_path), scanPills: row.repo_scan?.scanPills || [] },
    status: row.status,
  };
}

function shortRepoLabel(repoPath) {
  const match = repoPath.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return match ? `${match[1]}/${match[2]}` : repoPath;
}

// POST /api/sessions -- stages 1-2: read the repo, ask clarifying questions.
router.post('/', async (req, res, next) => {
  try {
    const { description, repoPath, githubPat } = req.body;
    if (!description || !repoPath) {
      return res.status(400).json({ error: 'description and repoPath are required' });
    }

    // Root trace for this request -- every completeJson() call inside
    // runIntake (just "clarify") nests under it automatically via OTel
    // context propagation, no explicit wiring needed in the pipeline stages.
    const { repo, questions } = await startActiveObservation('intake', () =>
      runIntake({ description, repoPath, githubPat })
    );

    const sessionResult = await query(
      `INSERT INTO sessions (description, repo_path, repo_scan, status)
       VALUES ($1, $2, $3, 'clarifying') RETURNING *`,
      [
        description,
        repoPath,
        JSON.stringify({
          rootDir: repo.rootDir,
          // Only true for a GitHub-URL clone (repoReader.js's cloneToTemp) --
          // never for a local repoPath, which must never be deleted.
          cleanup: !!repo.cleanup,
          files: repo.files,
          contextText: repo.contextText,
          scanPills: repo.scanPills,
          stackLabel: repo.stackLabel,
        }),
      ]
    );
    const session = sessionResult.rows[0];

    const insertedQuestions = [];
    for (const q of questions) {
      const r = await query(
        `INSERT INTO questions (session_id, seq, axis, question, grounded_file)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [session.id, q.seq, q.axis, q.question, q.groundedFile]
      );
      insertedQuestions.push(r.rows[0]);
    }

    res.json({
      ...shapeSession(session),
      questions: insertedQuestions.map((q) => ({
        id: q.id,
        seq: q.seq,
        axis: q.axis,
        question: q.question,
        groundedFile: q.grounded_file,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/sessions/:id/answers -- stages 3-8: analysis through the coverage gate.
router.post('/:id/answers', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { answers } = req.body;
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers[] is required' });

    const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ error: 'session not found' });

    const questionsResult = await query('SELECT * FROM questions WHERE session_id = $1 ORDER BY seq', [id]);
    const questionRows = questionsResult.rows;

    const answersById = new Map(answers.map((a) => [a.questionId, a]));
    const mergedAnswers = [];
    for (const q of questionRows) {
      const a = answersById.get(q.id) || {};
      await query('UPDATE questions SET answer = $1, flagged = $2 WHERE id = $3', [
        a.answer || null,
        a.flagged || null,
        q.id,
      ]);
      mergedAnswers.push({
        axis: q.axis,
        question: q.question,
        answer: a.answer || null,
        flagged: a.flagged || null,
        groundedFile: q.grounded_file,
      });
    }

    const repo = session.repo_scan;
    let analysis;
    try {
      analysis = await startActiveObservation('analysis', () =>
        runAnalysis({ description: session.description, repo, answers: mergedAnswers })
      );
    } finally {
      // repoReader.js's cloneToTemp() never deletes its own clone (blastRadius,
      // called from runAnalysis, still needs it) -- this is the one place that
      // does, once analysis is done with it. Runs on failure too, so a bad
      // analysis attempt doesn't leak the clone either.
      if (repo.cleanup) {
        await rm(repo.rootDir, { recursive: true, force: true }).catch((err) =>
          console.error(`cleanup failed for ${repo.rootDir}: ${err.message}`)
        );
      }
    }

    for (const f of analysis.findings) {
      await query(
        `INSERT INTO findings (session_id, file_path, description, grounded, confidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, f.filePath, f.description, f.grounded, f.confidence]
      );
    }
    for (const oq of analysis.openQuestions) {
      await query(
        `INSERT INTO open_questions (session_id, category, text, source, confidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, oq.category, oq.text, oq.source, oq.confidence]
      );
    }
    await query(
      `INSERT INTO documents
         (session_id, prd_markdown, trd_markdown, estimate_low, estimate_high, estimate_worst,
          blast_radius_file, blast_radius_count, coverage_passed, coverage_missing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (session_id) DO UPDATE SET
         prd_markdown = EXCLUDED.prd_markdown, trd_markdown = EXCLUDED.trd_markdown,
         estimate_low = EXCLUDED.estimate_low, estimate_high = EXCLUDED.estimate_high,
         estimate_worst = EXCLUDED.estimate_worst, blast_radius_file = EXCLUDED.blast_radius_file,
         blast_radius_count = EXCLUDED.blast_radius_count, coverage_passed = EXCLUDED.coverage_passed,
         coverage_missing = EXCLUDED.coverage_missing`,
      [
        id,
        analysis.prdMarkdown,
        analysis.trdMarkdown,
        analysis.estimateResult.low,
        analysis.estimateResult.high,
        analysis.estimateResult.worst,
        analysis.blastRadiusResult.file,
        analysis.blastRadiusResult.count,
        analysis.coverage.passed,
        JSON.stringify(analysis.coverage.missing),
      ]
    );
    await query("UPDATE sessions SET status = 'completed' WHERE id = $1", [id]);

    const groundedFiles = [...new Set(analysis.findings.filter((f) => f.grounded).map((f) => f.filePath))];
    const driving = [
      analysis.blastRadiusResult.file
        ? `${analysis.blastRadiusResult.file} has ${analysis.blastRadiusResult.count} references -- blast radius driver`
        : null,
      ...analysis.openQuestions
        .filter((q) => q.confidence === 'low')
        .map((q) => `Low-confidence open item: ${q.text}`),
    ].filter(Boolean);

    res.json({
      sessionId: id,
      estimate: analysis.estimateResult,
      blastRadius: analysis.blastRadiusResult,
      prd: analysis.prdMarkdown,
      trd: analysis.trdMarkdown,
      openQuestions: analysis.openQuestions,
      coverageGate: analysis.coverage,
      grounded: groundedFiles,
      driving,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/sessions/:id/github -- stage 9, opt-in. PAT is used for this
// request only and is never written to the database.
router.post('/:id/github', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { githubPat } = req.body;
    if (!githubPat) return res.status(400).json({ error: 'githubPat is required' });

    const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ error: 'session not found' });

    const openQuestionsResult = await query('SELECT * FROM open_questions WHERE session_id = $1', [id]);
    const openQuestions = openQuestionsResult.rows.map((r) => ({
      category: r.category,
      text: r.text,
      source: r.source,
      confidence: r.confidence,
    }));

    const { issues, errors } = await runGithubWriteback({
      repoPath: session.repo_path,
      githubPat,
      openQuestions,
      resTitle: session.description.slice(0, 80),
    });

    // Persist whichever issues actually succeeded, even if others failed --
    // partial success is still success for those, and swallowing them here
    // would make a retry create duplicates.
    for (const issue of issues) {
      await query('INSERT INTO github_issues (session_id, number, title, url) VALUES ($1, $2, $3, $4)', [
        id,
        issue.number,
        issue.title,
        issue.url,
      ]);
    }

    res.json({ issues, errors });
  } catch (err) {
    next(err);
  }
});

// GET /api/sessions/:id -- reload a session's full state.
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const sessionResult = await query('SELECT * FROM sessions WHERE id = $1', [id]);
    const session = sessionResult.rows[0];
    if (!session) return res.status(404).json({ error: 'session not found' });

    const questionsResult = await query('SELECT * FROM questions WHERE session_id = $1 ORDER BY seq', [id]);
    const docsResult = await query('SELECT * FROM documents WHERE session_id = $1', [id]);
    const openQuestionsResult = await query('SELECT * FROM open_questions WHERE session_id = $1', [id]);

    res.json({
      ...shapeSession(session),
      questions: questionsResult.rows,
      document: docsResult.rows[0] || null,
      openQuestions: openQuestionsResult.rows,
    });
  } catch (err) {
    next(err);
  }
});
