import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). Each test file runs in an isolated
// process, and this file imports config.js exactly once with every
// `format:`-hooked var set, so the assertions below cover the format
// callbacks (parseBoolean, Number, JSON.parse) in a single module instance
// the native coverage report can measure.
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
const envFormatsTrue = getFixture('env-formats-true.json');

for (const key of trackedVars) {
  delete process.env[key];
}
Object.assign(process.env, mandatoryEnv, envFormatsTrue);

const config = await import('../src/config.js');

describe('config.js value formats', () => {
  it('parseBoolean formatters: boolean envs are parsed, not passed through', () => {
    assert.equal(config.enableProxy, true);
    assert.equal(config.requireAuthForRead, true);
    assert.equal(config.requireKVPForWrite, true);
  });

  it('pollWaitTime env value is converted with Number()', () => {
    assert.equal(config.pollWaitTime, 500);
    assert.equal(typeof config.pollWaitTime, 'number');
  });

  it('ipWhiteList env value is converted with JSON.parse()', () => {
    assert.deepEqual(config.ipWhiteList, ['127.0.0.1', '10.0.0.1']);
  });
});
