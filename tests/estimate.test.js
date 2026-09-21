import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate } from '../src/pipeline/estimate.js';

test('base case: low blast radius, no open questions', () => {
  const r = estimate({ blastRadiusCount: 2, openQuestions: [] });
  assert.deepEqual(r, { low: 2, high: 3, worst: 5 });
});

test('high blast radius widens the high end', () => {
  const r = estimate({ blastRadiusCount: 12, openQuestions: [] });
  assert.equal(r.high, 5); // 3 + 2
});

test('low-confidence open questions widen the high end, capped at +3', () => {
  const openQuestions = [
    { confidence: 'low' },
    { confidence: 'low' },
    { confidence: 'low' },
    { confidence: 'low' },
  ];
  const r = estimate({ blastRadiusCount: 2, openQuestions });
  assert.equal(r.high, 6); // 3 + min(4,3)
});

test('worst case scales with total open question count', () => {
  const openQuestions = new Array(8).fill({ confidence: 'medium' });
  const r = estimate({ blastRadiusCount: 2, openQuestions });
  assert.equal(r.worst, r.high + 6); // ceil(8 * 0.75) = 6
});
