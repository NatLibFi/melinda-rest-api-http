import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). Each test file runs in an isolated
// process, and this file imports config.js exactly once with the boolean
// vars set to "false"/"0" — the negative branch of the parseBoolean format
// hooks (test/config-formats.test.js covers the "true"/"1"/"TRUE" branch in
// its own single-import instance).
// The env tables come from fixura fixtures in test-fixtures/config/ (house
// practice, per the record-load bridge repo).
// (Importing the same file multiple times via cache-busting query strings
// produces separate V8 scripts that the native coverage report cannot merge,
// so covered lines show as uncovered.)

const {getFixture} = fixturesFactory({
  root: [import.meta.dirname, '..', 'test-fixtures', 'config'],
  reader: READERS.JSON
});

// Every env var config.js consults; all are deleted at top level so this
// file does not inherit the surrounding environment.
const trackedVars = getFixture('tracked-vars.json');
const mandatoryEnv = getFixture('mandatory-env.json');
const envFormatsFalse = getFixture('env-formats-false.json');

for (const key of trackedVars) {
  delete process.env[key];
}
Object.assign(process.env, mandatoryEnv, envFormatsFalse);

const config = await import('../src/config.js');

describe('config.js value formats', () => {
  it('parseBoolean formatters parse "false"/"0" to false', () => {
    assert.equal(config.enableProxy, false);
    assert.equal(config.requireAuthForRead, false);
    assert.equal(config.requireKVPForWrite, false);
  });
});
