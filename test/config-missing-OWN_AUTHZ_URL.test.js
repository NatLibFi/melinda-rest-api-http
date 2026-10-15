import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). OWN_AUTHZ_URL is mandatory (no default), so an
// unset value makes the import itself throw before any API code runs. Each
// test file runs in an isolated process, so this file is the only place the
// unset OWN_AUTHZ_URL case is asserted: every tracked var is deleted, the other
// mandatory vars are set, and the single import is expected to reject with
// a message naming OWN_AUTHZ_URL.
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
// environment cannot mask the unset OWN_AUTHZ_URL case.
const trackedVars = getFixture('tracked-vars.json');
const mandatoryEnv = getFixture('mandatory-env.json');

describe('config.js mandatory vars', () => {
  it('rejects import when OWN_AUTHZ_URL is missing', async () => {
    for (const key of trackedVars) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(mandatoryEnv)) {
      if (key !== 'OWN_AUTHZ_URL') {
        process.env[key] = value;
      }
    }

    await assert.rejects(
      import('../src/config.js'),
      new RegExp(`Mandatory environment variable missing: OWN_AUTHZ_URL`)
    );
  });
});
