import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). IP_WHITELIST has a JSON.parse format hook,
// so a malformed value makes the import itself throw before any API code
// runs. Each test file runs in an isolated process, so this file is the only
// place the malformed-JSON case is asserted: the mandatory vars are set,
// IP_WHITELIST is set to invalid JSON, and the single import is expected to
// reject.
// The env tables come from fixura fixtures in test-fixtures/config/ (house
// practice, per the record-load bridge repo).
// (Importing the same file multiple times via cache-busting query strings
// produces separate V8 scripts that the native coverage report cannot merge,
// so covered lines show as uncovered.)

const {getFixture} = fixturesFactory({
  root: [import.meta.dirname, '..', 'test-fixtures', 'config'],
  reader: READERS.JSON
});

// Every env var config.js consults; all are deleted so the surrounding
// environment cannot mask the malformed IP_WHITELIST case.
const trackedVars = getFixture('tracked-vars.json');
const mandatoryEnv = getFixture('mandatory-env.json');
const envMalformed = getFixture('env-ip-whitelist-malformed.json');

describe('config.js ipWhiteList malformed JSON', () => {
  it('ipWhiteList rejects malformed JSON', async () => {
    for (const key of trackedVars) {
      delete process.env[key];
    }
    Object.assign(process.env, mandatoryEnv, envMalformed);

    await assert.rejects(
      import('../src/config.js'),
      (err) => err instanceof SyntaxError
    );
  });
});
