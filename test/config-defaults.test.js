import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {CONVERSION_FORMATS} from '@natlibfi/melinda-rest-api-commons';
import fixturesFactory, {READERS} from '@natlibfi/fixura';

// config.js captures the environment at import time (top-level
// readEnvironmentVariable calls). Each test file runs in an isolated
// process, and this file imports config.js exactly once with every optional
// var left unset, so the assertions below cover the default-value paths.
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

for (const key of trackedVars) {
  delete process.env[key];
}
Object.assign(process.env, mandatoryEnv);

const config = await import('../src/config.js');

describe('config.js defaults', () => {
  it('imports successfully with only the mandatory vars set', () => {
    assert.ok(config);
  });

  it('exposes the mandatory vars as given', () => {
    assert.equal(config.xServiceURL, mandatoryEnv.ALEPH_X_SVC_URL);
    assert.equal(config.userLibrary, mandatoryEnv.ALEPH_USER_LIBRARY);
    assert.equal(config.ownAuthzURL, mandatoryEnv.OWN_AUTHZ_URL);
    assert.equal(config.ownAuthzApiKey, mandatoryEnv.OWN_AUTHZ_API_KEY);
    assert.equal(config.sruUrl, mandatoryEnv.SRU_URL);
  });

  it('httpPort defaults to the string "8080"', () => {
    assert.equal(config.httpPort, '8080');
  });

  it('enableProxy defaults to boolean false', () => {
    assert.equal(config.enableProxy, false);
  });

  it('amqpUrl defaults to the local broker url', () => {
    assert.equal(config.amqpUrl, 'amqp://127.0.0.1:5672/');
  });

  it('mongoUri defaults to the local mongo url', () => {
    assert.equal(config.mongoUri, 'mongodb://127.0.0.1:27017/db');
  });

  it('pollWaitTime defaults to the number 100', () => {
    assert.equal(config.pollWaitTime, 100);
    assert.equal(typeof config.pollWaitTime, 'number');
  });

  it('recordType defaults to "bib"', () => {
    assert.equal(config.recordType, 'bib');
  });

  it('requireAuthForRead defaults to boolean false', () => {
    assert.equal(config.requireAuthForRead, false);
  });

  it('requireKVPForWrite defaults to boolean false', () => {
    assert.equal(config.requireKVPForWrite, false);
  });

  it('DEFAULT_ACCEPT defaults to "application/json"', () => {
    assert.equal(config.DEFAULT_ACCEPT, 'application/json');
  });

  it('fixTypes defaults to the array ["DELET", "UNDEL"]', () => {
    assert.deepEqual(config.fixTypes, ['DELET', 'UNDEL']);
  });

  it('allowedLibs defaults to the empty array', () => {
    assert.deepEqual(config.allowedLibs, []);
    assert.ok(Array.isArray(config.allowedLibs));
  });

  it('ipWhiteList defaults to the empty array', () => {
    assert.deepEqual(config.ipWhiteList, []);
    assert.ok(Array.isArray(config.ipWhiteList));
  });
});

describe('config.js CONTENT_TYPES', () => {
  it('imports successfully', () => {
    assert.ok(config.CONTENT_TYPES);
  });

  it('has four entries', () => {
    assert.equal(config.CONTENT_TYPES.length, 4);
  });

  it('every entry has the keys contentType/conversionFormat/allowPrio/allowBulk/allowAddRecords', () => {
    for (const entry of config.CONTENT_TYPES) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'allowAddRecords',
        'allowBulk',
        'allowPrio',
        'contentType',
        'conversionFormat'
      ]);
    }
  });

  it('lists the expected content types, conversion formats and flags', () => {
    assert.deepEqual(
      config.CONTENT_TYPES.map((entry) => [
        entry.contentType,
        entry.conversionFormat,
        entry.allowPrio,
        entry.allowBulk,
        entry.allowAddRecords
      ]),
      [
        ['application/json', CONVERSION_FORMATS.JSON, true, true, true],
        ['application/marc', CONVERSION_FORMATS.ISO2709, true, true, false],
        ['application/xml', CONVERSION_FORMATS.MARCXML, true, true, false],
        ['application/alephseq', CONVERSION_FORMATS.ALEPHSEQ, false, true, false]
      ]
    );
  });
});
