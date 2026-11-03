import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// Smoke test: proves the node --test runner and coverage report work.
// Intentionally trivial; real suites are added in later issues.

function add(a, b) {
  return a + b;
}

describe('smoke', () => {
  it('runs', () => {
    assert.equal(true, true);
  });

  it('exercises a tiny local function (coverage check)', () => {
    assert.equal(add(1, 2), 3);
  });
});
