import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJson } from '../src/llm/parseJson.js';

test('plain JSON, no fence', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
});

test('fenced with no surrounding prose', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('fenced with leading prose (the regression case)', () => {
  assert.deepEqual(parseJson('Here is the JSON:\n```json\n{"a":1}\n```'), { a: 1 });
});

test('no fence at all, prose wrapped around raw JSON', () => {
  assert.deepEqual(parseJson('Sure, here you go: [1,2,3] -- hope that helps!'), [1, 2, 3]);
});

test('genuinely invalid JSON still throws', () => {
  assert.throws(() => parseJson('not json at all'), /did not return valid JSON/);
});
