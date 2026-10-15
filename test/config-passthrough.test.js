import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). Each test file runs in an isolated
// process, and this file imports config.js exactly once with the
// format-less (plain string) vars set, so the assertions below cover the
// raw-passthrough path.
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
const envPassthrough = getFixture('env-passthrough.json');

for (const key of trackedVars) {
  delete process.env[key];
}
Object.assign(process.env, mandatoryEnv, envPassthrough);

const config = await import('../src/config.js');

describe('config.js value formats', () => {
  it('plain string vars pass the env value through unchanged', () => {
    assert.equal(config.httpPort, envPassthrough.HTTP_PORT);
    assert.equal(config.amqpUrl, envPassthrough.AMQP_URL);
    assert.equal(config.mongoUri, envPassthrough.MONGO_URI);
    assert.equal(config.recordType, envPassthrough.RECORD_TYPE);
    assert.equal(config.DEFAULT_ACCEPT, envPassthrough.DEFAULT_ACCEPT);
  });

  // NOTE (suspected bug, asserted as actual behavior, NOT fixed here):
  // FIX_TYPES and ALLOWED_LIBS have array defaults but no `format` hook, so
  // an env value is returned as the raw string ("DELET,UNDEL"), never
  // parsed into an array. Consumers expecting an array would break on any
  // deployment that sets these vars.
  it('FIX_TYPES env value passes through as a raw string (no format hook)', () => {
    assert.equal(config.fixTypes, envPassthrough.FIX_TYPES);
  });

  it('ALLOWED_LIBS env value passes through as a raw string (no format hook)', () => {
    assert.equal(config.allowedLibs, envPassthrough.ALLOWED_LIBS);
  });
});
