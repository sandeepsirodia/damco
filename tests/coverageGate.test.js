import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageGate } from '../src/pipeline/coverageGate.js';

test('passes when every grounded finding is cited in the docs', () => {
  const result = coverageGate({
    findings: [{ filePath: 'routes/orders.js', description: 'high blast radius' }],
    prdMarkdown: 'See `routes/orders.js` for details.',
    trdMarkdown: 'No further notes.',
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.missing, []);
});

test('fails and lists a finding whose file never made it into the docs', () => {
  const result = coverageGate({
    findings: [{ filePath: 'lib/csv.js', description: 'new utility needed' }],
    prdMarkdown: 'Nothing about csv here.',
    trdMarkdown: 'Also nothing.',
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.missing, ['lib/csv.js']);
});

test('general findings without a file path fall back to keyword overlap', () => {
  const result = coverageGate({
    findings: [{ filePath: null, description: 'no timezone handling found anywhere' }],
    prdMarkdown: 'This PRD never mentions the timezone problem.',
    trdMarkdown: '',
  });
  assert.equal(result.passed, true);
});
