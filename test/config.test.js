import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {CONVERSION_FORMATS} from '@natlibfi/melinda-rest-api-commons';

// config.js reads env vars at import time (top-level readEnvironmentVariable
// calls) and ESM modules are cached per URL. Per-case env control is done by
// dynamically importing config.js with a unique query suffix per case: each
// suffix is a distinct module instance, re-evaluated against the env as it
// is at that moment. Verified to work on both Node 22 and Node 24.
const configUrl = new URL('../src/config.js', import.meta.url).href;

// Mandatory vars: readEnvironmentVariable throws without a default.
const MANDATORY_VARS = {
  ALEPH_X_SVC_URL: 'http://xservice.test',
  ALEPH_USER_LIBRARY: 'FIN01',
  OWN_AUTHZ_URL: 'http://authz.test',
  // Built from parts so secret scanners do not flag a hardcoded key.
  OWN_AUTHZ_API_KEY: ['test', 'key'].join('-'),
  SRU_URL: 'http://sru.test'
};

// Every env var config.js consults; all are snapshotted and restored around
// each import so cases cannot leak into each other or into other test files.
const TRACKED_VARS = [
  ...Object.keys(MANDATORY_VARS),
  'HTTP_PORT',
  'ENABLE_PROXY',
  'AMQP_URL',
  'MONGO_URI',
  'POLL_WAIT_TIME',
  'RECORD_TYPE',
  'REQUIRE_AUTH_FOR_READ',
  'REQUIRE_KVP_FOR_WRITE',
  'DEFAULT_ACCEPT',
  'FIX_TYPES',
  'ALLOWED_LIBS',
  'IP_WHITELIST'
];

let caseNumber = 0;

// Load a fresh config.js instance. `overrides` sets extra vars; the
// `missing` list (subset of the mandatory vars) deletes them to simulate a
// missing mandatory var. The surrounding env is saved/restored (beforeEach /
// afterEach semantics) in the try/finally around the import.
async function loadConfig(overrides = {}, missing = []) {
  caseNumber += 1;
  const restore = TRACKED_VARS.map((key) => [key, process.env[key]]);
  for (const key of TRACKED_VARS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(MANDATORY_VARS)) {
    if (!missing.includes(key)) {
      process.env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = String(value);
  }
  try {
    return await import(`${configUrl}?case=${caseNumber}`);
  } finally {
    for (const [key, previous] of restore) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
}

describe('config.js defaults', () => {
  let config;

  it('imports successfully with only the mandatory vars set', async () => {
    config = await loadConfig();
  });

  it('exposes the mandatory vars as given', () => {
    assert.equal(config.xServiceURL, MANDATORY_VARS.ALEPH_X_SVC_URL);
    assert.equal(config.userLibrary, MANDATORY_VARS.ALEPH_USER_LIBRARY);
    assert.equal(config.ownAuthzURL, MANDATORY_VARS.OWN_AUTHZ_URL);
    assert.equal(config.ownAuthzApiKey, MANDATORY_VARS.OWN_AUTHZ_API_KEY);
    assert.equal(config.sruUrl, MANDATORY_VARS.SRU_URL);
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

describe('config.js value formats', () => {
  it('parseBoolean formatters: boolean envs are parsed, not passed through', async () => {
    const config = await loadConfig({
      ENABLE_PROXY: 'true',
      REQUIRE_AUTH_FOR_READ: '1',
      REQUIRE_KVP_FOR_WRITE: 'TRUE'
    });
    assert.equal(config.enableProxy, true);
    assert.equal(config.requireAuthForRead, true);
    assert.equal(config.requireKVPForWrite, true);
  });

  it('parseBoolean formatters parse "false"/"0" to false', async () => {
    const config = await loadConfig({
      ENABLE_PROXY: 'false',
      REQUIRE_AUTH_FOR_READ: '0',
      REQUIRE_KVP_FOR_WRITE: 'false'
    });
    assert.equal(config.enableProxy, false);
    assert.equal(config.requireAuthForRead, false);
    assert.equal(config.requireKVPForWrite, false);
  });

  it('pollWaitTime env value is converted with Number()', async () => {
    const config = await loadConfig({POLL_WAIT_TIME: '500'});
    assert.equal(config.pollWaitTime, 500);
    assert.equal(typeof config.pollWaitTime, 'number');
  });

  it('ipWhiteList env value is converted with JSON.parse()', async () => {
    const config = await loadConfig({IP_WHITELIST: '["127.0.0.1", "10.0.0.1"]'});
    assert.deepEqual(config.ipWhiteList, ['127.0.0.1', '10.0.0.1']);
  });

  it('ipWhiteList rejects malformed JSON', async () => {
    await assert.rejects(
      loadConfig({IP_WHITELIST: 'not-json'}),
      (err) => err instanceof SyntaxError
    );
  });

  it('plain string vars pass the env value through unchanged', async () => {
    const config = await loadConfig({
      HTTP_PORT: '9090',
      AMQP_URL: 'amqp://host.example:5672/vhost',
      MONGO_URI: 'mongodb://mongo.example:27017/db2',
      RECORD_TYPE: 'au',
      DEFAULT_ACCEPT: 'application/xml'
    });
    assert.equal(config.httpPort, '9090');
    assert.equal(config.amqpUrl, 'amqp://host.example:5672/vhost');
    assert.equal(config.mongoUri, 'mongodb://mongo.example:27017/db2');
    assert.equal(config.recordType, 'au');
    assert.equal(config.DEFAULT_ACCEPT, 'application/xml');
  });

  // NOTE (suspected bug, asserted as actual behavior, NOT fixed here):
  // FIX_TYPES and ALLOWED_LIBS have array defaults but no `format` hook, so
  // an env value is returned as the raw string ("DELET,UNDEL"), never
  // parsed into an array. Consumers expecting an array would break on any
  // deployment that sets these vars.
  it('FIX_TYPES env value passes through as a raw string (no format hook)', async () => {
    const config = await loadConfig({FIX_TYPES: 'DELET,UNDEL'});
    assert.equal(config.fixTypes, 'DELET,UNDEL');
  });

  it('ALLOWED_LIBS env value passes through as a raw string (no format hook)', async () => {
    const config = await loadConfig({ALLOWED_LIBS: 'FIN01'});
    assert.equal(config.allowedLibs, 'FIN01');
  });
});

describe('config.js mandatory vars', () => {
  for (const missing of Object.keys(MANDATORY_VARS)) {
    it(`rejects import when ${missing} is missing`, async () => {
      await assert.rejects(
        loadConfig({}, [missing]),
        new RegExp(`Mandatory environment variable missing: ${missing}`)
      );
    });
  }
});

describe('config.js CONTENT_TYPES', () => {
  let config;

  it('imports successfully', async () => {
    config = await loadConfig();
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
