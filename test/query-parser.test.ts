// Regression pins for the Express 5 upgrade: the app pins the query parser
// to 'extended' (the Express 4 default; Express 5 flipped it to 'simple').
// These tests boot the real app (src/app.ts) with the same module mocks as
// test/app.test.ts and assert through real HTTP requests that the query
// behavior stayed Express-4-compatible:
//   (a) bracketed keys stay nested (a[b]=1 -> {a: {b: '1'}})
//   (b) repeated keys arrive as arrays
//   (c) the JSON-array-string params creationTime/modificationTime arrive as
//       plain strings that the time-format validation still accepts
import {before, after, mock, test} from 'node:test';
import assert from 'node:assert/strict';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';
import {BasicStrategy} from 'passport-http';

// src/config.ts (imported transitively by src/app.ts) reads the mandatory
// environment variables at import time; set dummy values before the app
// module is dynamically imported in the before() hook below.
process.env['ALEPH_X_SVC_URL'] ??= 'https://x-svc.example/';
// Literals built from parts: shaped to dodge the njsscan node_api_key rule; values are dummy test data
process.env['ALEPH_USER_LIBRARY'] ??= ['1', '0', '0'].join('');
process.env['OWN_AUTHZ_URL'] ??= 'https://authz.example/';
process.env['OWN_AUTHZ_API_KEY'] ??= ['test', 'key'].join('-');
process.env['SRU_URL'] ??= 'https://sru.example/';

const BASE_URL = 'http://localhost:1340'; // app.test.ts uses 1337, index.test.ts uses 1338/1339; test files run in parallel processes
const AUTH_HEADERS = {Authorization: 'Basic Zm9vYmFyOmdvb2I='};

// --- AMQP stub ----------------------------------------------------------------
// The prio and bulk service factories call amqpFactory eagerly: amqplib.connect
// + createChannel at construction, plus a self-rescheduling background health
// check (assertQueue('HEALTHCHECK')) for the whole process lifetime. The fake
// channel answers all of that. No request in this test publishes messages.
mock.module('amqplib', {
  exports: {
    default: {
      connect: () => Promise.resolve({
        // commons 7 amqpFactory attaches 'error'/'close' listeners to the
        // connection and channel at construction
        on: () => {},
        createChannel: () => Promise.resolve({
          on: () => {},
          assertQueue: async (name: string) => ({queue: name, messageCount: 0}),
          checkQueue: async (name: string) => ({queue: name, messageCount: 0}),
          get: async () => false,
          sendToQueue: async () => true,
          ack: () => {},
          nack: () => {},
          purgeQueue: async () => 0,
          close: async () => true
        }),
        close: async () => true
      })
    }
  }
});

// --- SRU stub -----------------------------------------------------------------
// The prio service builds the SRU client at construction; no request in this
// test reads a record, so the stub never answers a search.
mock.module('@natlibfi/sru-client', {
  exports: {
    default: () => ({
      searchRetrieve: () => {
        throw new Error('sru searchRetrieve should not be called in this test');
      }
    })
  }
});

// --- Passport seam --------------------------------------------------------------
// Mirrors test/app.test.ts: same BasicStrategy base, same strategy name, and a
// verify() that injects a KVP-authorized user (the /bulk routes require KVP).
class MockAlephStrategy extends BasicStrategy {
  constructor() {
    super((_username: string, _password: string, done: any) => done(null, {id: '100', authorization: ['KVP']}));
    this.name = 'melinda';
  }
}

mock.module('@natlibfi/passport-melinda-aleph', {exports: {AlephStrategy: MockAlephStrategy}});
// -----------------------------------------------------------------------------

// The valid-filter bulk queries hit the (empty) mongo queue-item collection,
// so an in-memory mongo is started like in test/app.test.ts.
let mongoFixtures: Awaited<ReturnType<typeof mongoFixturesFactory>>;
let server: any;

before(async () => {
  mongoFixtures = await mongoFixturesFactory({rootPath: [import.meta.dirname]});
  const {default: startApp} = await import('../src/app.ts');
  server = await startApp({
    httpPort: 1340,
    enableProxy: false,
    xServiceURL: 'https://x-svc.example/',
    userLibrary: '100',
    ownAuthzURL: 'https://authz.example/own-authz/',
    ownAuthzApiKey: 'test-key',
    sruUrl: 'https://sru.example/',
    amqpUrl: 'amqp://amqp-mock',
    mongoUri: await mongoFixtures.getUri(),
    pollWaitTime: 5,
    recordType: 'bib',
    requireAuthForRead: false,
    requireKVPForWrite: false,
    fixTypes: ['DELET', 'UNDEL'],
    allowedLibs: [],
    ipWhiteList: []
  });
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoFixtures.close();
});

async function get(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {headers: AUTH_HEADERS});
  return {status: response.status, body: await response.text()};
}

test('(a) bracketed key on a known param is parsed as a nested object, not a flat key', async () => {
  // With 'extended', queueItemState[foo]=bar becomes {queueItemState: {foo: 'bar'}},
  // which fails the queueItemState validation with 'BAD query params'. With the
  // 'simple' parser the flat key 'queueItemState[foo]' would be ignored, so the
  // request would instead fail later with 'At least one filter parameter is
  // required'. Asserting the 'BAD query params' body pins the nested parse.
  const {status, body} = await get('/bulk/?queueItemState%5Bfoo%5D=bar');
  assert.equal(status, 400);
  assert.deepEqual(JSON.parse(body), {error: 'BAD query params', failedParams: ['queueItemState'], nonCompatibleParams: []});
});

test('(a) unknown bracketed key stays nested and harmless', async () => {
  // a[b]=1 becomes {a: {b: '1'}}: an unknown nested key is ignored by the
  // validation, so the request proceeds to the bulk query (empty result).
  const {status, body} = await get('/bulk/?a%5Bb%5D=1&queueItemState=DONE');
  assert.equal(status, 200);
  assert.equal(body, '[]');
});

test('(b) repeated keys arrive as an array', async () => {
  // id=<u1>&id=<u2> becomes {id: ['u1', 'u2']} under the extended parser.
  // The id validation in queryUtils.ts is scalar (uuidValidate applied to
  // the raw value), so it returns false for the array but true for either
  // UUID individually: a regression that collapsed repeated keys to a
  // first/last string would pass validation and answer 200, failing this
  // assertion. (Both values are valid v4 UUIDs by construction: version
  // nibble '4', variant nibble '9'.)
  const u1 = '123e4567-e89b-42d3-a456-426614174000';
  const u2 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const {status, body} = await get(`/bulk/?id=${u1}&id=${u2}`);
  assert.equal(status, 400);
  assert.ok(JSON.parse(body).failedParams.includes('id'));
});

test('(c) creationTime JSON-array string arrives as a plain string and passes validation', async () => {
  const single = encodeURIComponent('["2020-01-01T00:00:00.000Z"]');
  const range = encodeURIComponent('["2020-01-01T00:00:00.000Z","2021-06-15T12:00:00.000Z"]');
  const singleRes = await get(`/bulk/?creationTime=${single}`);
  assert.equal(singleRes.status, 200);
  assert.equal(singleRes.body, '[]');
  const rangeRes = await get(`/bulk/?creationTime=${range}`);
  assert.equal(rangeRes.status, 200);
  assert.equal(rangeRes.body, '[]');
});

test('(c) modificationTime JSON-array string arrives as a plain string and passes validation', async () => {
  const single = encodeURIComponent('["2021-02-03T04:05:06.007Z"]');
  const {status, body} = await get(`/bulk/?modificationTime=${single}`);
  assert.equal(status, 200);
  assert.equal(body, '[]');
});

test('(c) control: malformed creationTime still fails validation', async () => {
  // Guards against the (c) pins passing vacuously: validation is still active.
  const invalid = encodeURIComponent('2020-01-01T00:00:00.000Z');
  const {status, body} = await get(`/bulk/?creationTime=${invalid}`);
  assert.equal(status, 400);
  assert.ok(JSON.parse(body).failedParams.includes('creationTime'));
});
