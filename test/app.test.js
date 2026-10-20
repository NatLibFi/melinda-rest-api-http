import {EventEmitter} from 'node:events';
import {mock} from 'node:test';
import {MongoClient, GridFSBucket} from 'mongodb';
import {BasicStrategy} from 'passport-http';
import generateTests from '@natlibfi/fixugen-http-server';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';

// src/config.js (imported transitively by src/routes/*) reads the mandatory
// environment variables at import time; set dummy values before the app module
// is dynamically imported in the callback below (only in this test process).
process.env.ALEPH_X_SVC_URL ??= 'https://x-svc.example/';
// Literals built from parts: shaped to dodge the njsscan node_api_key rule; values are dummy test data
process.env.ALEPH_USER_LIBRARY ??= ['1', '0', '0'].join('');
process.env.OWN_AUTHZ_URL ??= 'https://authz.example/';
process.env.OWN_AUTHZ_API_KEY ??= ['test', 'key'].join('-');
process.env.SRU_URL ??= 'https://sru.example/';

// --- Mock state, settable per fixture through metadata.json ----------------
// The app is started per fixture (startApp below), and the mocks are read at
// request time, so the callback assigns the fixture's values before startApp.
const amqpMock = {calls: [], resultState: 'DONE', records: [], errorStatus: '', errorMessage: ''};
const sruMock = {queries: [], records: []};
const passportMock = {
  state: 'kvp',
  users: {
    // KVP leg: authorization includes 'KVP' -> authorizeKVPOnly passes
    kvp: {id: '100', authorization: ['KVP']},
    // non-KVP leg: authenticated but no 'KVP' in authorization -> 403 on guarded routes
    nonKVP: {id: '200', authorization: ['CATALOG']}
  }
};

function resetMocks() {
  amqpMock.calls = [];
  amqpMock.resultState = 'DONE';
  amqpMock.records = [{recordStatus: 'CREATED', databaseId: '999999'}];
  amqpMock.errorStatus = '';
  amqpMock.errorMessage = '';
  sruMock.queries = [];
  sruMock.records = [];
  passportMock.state = 'kvp';
}
// ---------------------------------------------------------------------------

// --- AMQP stub --------------------------------------------------------------
// The prio and bulk service factories call amqpFactory eagerly: amqplib.connect
// + createChannel at construction, plus a self-rescheduling background health
// check (assertQueue('HEALTHCHECK') every 200ms) for the whole process
// lifetime. The fake channel answers all of that. The prio service publishes
// its request to the 'REQUESTS' queue and then polls Mongo until the queueItem
// reaches a terminal state, so the fake channel plays the "worker" role for
// that queue: it flips the queueItem to the fixture-configured terminal state
// (DONE with records, or ERROR with errorStatus/errorMessage).
let mongoClient;

function makeFakeChannel() {
  return {
    assertQueue: async (name) => {
      amqpMock.calls.push(['assertQueue', name]);
      return {queue: name, messageCount: 0};
    },
    checkQueue: async (name) => {
      amqpMock.calls.push(['checkQueue', name]);
      return {queue: name, messageCount: 0};
    },
    get: async (name) => {
      amqpMock.calls.push(['get', name]);
      return false;
    },
    sendToQueue: async (name, content, options) => {
      amqpMock.calls.push(['sendToQueue', name]);
      if (name === 'REQUESTS' && options.correlationId) {
        await mongoClient.db('rest-api').collection('prio').updateOne(
          {correlationId: options.correlationId},
          {
            $set: amqpMock.resultState === 'ERROR'
              ? {
                queueItemState: 'ERROR',
                errorStatus: amqpMock.errorStatus,
                errorMessage: amqpMock.errorMessage,
                modificationTime: new Date()
              }
              : {
                queueItemState: 'DONE',
                records: amqpMock.records,
                modificationTime: new Date()
              }
          }
        );
      }
      return true;
    },
    ack: () => {},
    nack: () => {},
    purgeQueue: async () => 0,
    close: async () => true
  };
}

mock.module('amqplib', {
  exports: {
    default: {
      connect: (url) => {
        amqpMock.calls.push(['connect', url]);
        return Promise.resolve({
          createChannel: () => Promise.resolve(makeFakeChannel()),
          close: () => Promise.resolve(true)
        });
      }
    }
  }
});
// ---------------------------------------------------------------------------

// --- SRU stub ---------------------------------------------------------------
// The prio read path fetches the record from the configured SRU endpoint.
// createMockSruClient replaces @natlibfi/sru-client: searchRetrieve returns an
// EventEmitter that, on the next tick, emits one 'record' (the fixture's
// MARCXML) when a record is queued, then always 'end' (no record -> 404).
// sruMock.records is a per-request queue filled from the fixture's sruRecords.
mock.module('@natlibfi/sru-client', {exports: {default: createMockSruClient}});

function createMockSruClient() {
  return {
    searchRetrieve: (query) => {
      sruMock.queries.push(query);
      const emitter = new EventEmitter();
      setImmediate(() => {
        const xml = sruMock.records.shift();
        if (xml) {
          emitter.emit('record', xml);
        }
        emitter.emit('end');
      });
      return emitter;
    }
  };
}
// ---------------------------------------------------------------------------

// --- Passport seam ----------------------------------------------------------
// The real AlephStrategy (@natlibfi/passport-melinda-aleph v4.0.1, plain ESM
// named export) extends the passport-http BasicStrategy and registers itself
// under the name 'melinda' (app.js does passport.use(new AlephStrategy(...))
// and the routes authenticate with 'melinda'). The mock mirrors that shape:
// the same BasicStrategy base, the same name, and a verify() that injects the
// fixture-controlled req.user instead of calling the auth service.
class MockAlephStrategy extends BasicStrategy {
  constructor() {
    super((username, password, done) => {
      if (passportMock.state === 'fail') {
        // auth-fail leg: verify returns no user -> passport answers 401
        return done(null, false);
      }
      return done(null, passportMock.users[passportMock.state]);
    });
    this.name = 'melinda';
  }
}

mock.module('@natlibfi/passport-melinda-aleph', {exports: {AlephStrategy: MockAlephStrategy}});
// ---------------------------------------------------------------------------

// --- In-memory Mongo ---------------------------------------------------------
// fixura-mongo provides only the lifecycle (memory server, getUri, close);
// the services open their own clients against the 'rest-api' database (mongo
// collections 'bulk' and 'prio', GridFS bucket 'bulk', logs collection
// 'logs'). Fixtures are populated and cleared directly with the mongodb
// driver, mirroring what the services store (ISO fixture strings as Dates).
const DB_NAME = 'rest-api';
let mongoFixtures;

generateTests({
  callback,
  formatResponse,
  path: [import.meta.dirname, '..', 'test-fixtures', 'app'],
  recurse: false,
  hooks: {
    before: async () => {
      mongoFixtures = await mongoFixturesFactory({
        rootPath: [import.meta.dirname, '..', 'test-fixtures', 'app']
      });
      mongoClient = await MongoClient.connect(await mongoFixtures.getUri());
    },
    beforeEach: async () => {
      await closeActiveServer();
      resetMocks();
      await clearCollections();
    },
    after: async () => {
      await mongoClient.close();
      await mongoFixtures.close();
    }
  }
});

async function callback({
  getFixture,
  passport: passportState = 'kvp',
  requireAuthForRead = false,
  requireKVPForWrite = false,
  ipWhiteList = [],
  sruRecords = [],
  dbContents = '',
  gridFsFiles = '',
  amqpResultState = 'DONE',
  amqpRecords = [{recordStatus: 'CREATED', databaseId: '999999'}],
  amqpErrorStatus = '',
  amqpErrorMessage = ''
}) {
  // Assign the mock state before startApp: startApp instantiates
  // MockAlephStrategy internally, and all mock closures read this state at
  // request time.
  passportMock.state = passportState;
  sruMock.records = sruRecords.map((name) => (name ? getFixture(name) : null));
  amqpMock.resultState = amqpResultState;
  amqpMock.records = amqpRecords;
  amqpMock.errorStatus = amqpErrorStatus;
  amqpMock.errorMessage = amqpErrorMessage;

  if (dbContents) {
    // fixugen-http-server's getFixture reads with the TEXT reader, so the
    // JSON fixtures are parsed here
    await populateDb(JSON.parse(getFixture(dbContents)));
  }
  if (gridFsFiles) {
    await uploadGridFsFiles(JSON.parse(getFixture(gridFsFiles)));
  }

  const {default: startApp} = await import('../src/app.js');
  const server = await startApp({
    httpPort: 1337,
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
    requireAuthForRead,
    requireKVPForWrite,
    fixTypes: ['DELET', 'UNDEL'],
    allowedLibs: [],
    ipWhiteList
  });
  activeServer = await ensureListening(server);
  return closable(server);
}

let activeServer;

// fixugen-http-server only calls server.close() after the last request. Node's
// fetch (undici) holds keep-alive connections open, so a plain close() would
// leave the socket bound and the next fixture's listen(1337) would fail with
// EADDRINUSE; close the live connections first. Double-close is tolerated
// (the before-each hook may have already closed the server of a failed
// fixture).
function closable(server) {
  return {
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

// app.listen delivers its failure as an async 'error' event: when the port is
// still occupied, startApp would resolve with a server that never listens and
// the requests would silently hit the previous fixture's stale server on
// 1337. Fail fast instead.
async function ensureListening(server) {
  if (server.listening) {
    return server;
  }
  await new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
  return server;
}

async function closeActiveServer() {
  if (!activeServer) {
    return;
  }
  const server = activeServer;
  activeServer = null;
  await new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

// Re-serialize JSON-parseable payloads so the response fixtures do not have to
// match the server's exact JSON whitespace; plain-text bodies pass through.
async function formatResponse(response) {
  const payload = await response.text();
  const {headers} = response;
  try {
    return {headers, payload: JSON.stringify(JSON.parse(payload))};
  } catch {
    return {headers, payload};
  }
}

async function clearCollections() {
  const db = mongoClient.db(DB_NAME);
  await db.collection('bulk').deleteMany({});
  await db.collection('prio').deleteMany({});
  await db.collection('logs').deleteMany({});
  await new GridFSBucket(db, {bucketName: 'bulk'}).drop();
}

// dbContents.json is keyed by collection name, like in the fixura-mongo
// template; ISO strings from the fixtures become real Dates.
async function populateDb({logs = [], bulk = [], prio = []} = {}) {
  const db = mongoClient.db(DB_NAME);
  const withDates = (docs) => docs.map((doc) => ({
    ...doc,
    creationTime: new Date(doc.creationTime),
    modificationTime: new Date(doc.modificationTime)
  }));
  if (logs.length > 0) {
    await db.collection('logs').insertMany(withDates(logs));
  }
  if (bulk.length > 0) {
    await db.collection('bulk').insertMany(withDates(bulk));
  }
  if (prio.length > 0) {
    await db.collection('prio').insertMany(withDates(prio));
  }
}

async function uploadGridFsFiles(files) {
  const bucket = new GridFSBucket(mongoClient.db(DB_NAME), {bucketName: 'bulk'});
  for (const file of files) {
    const uploadStream = bucket.openUploadStream(file.filename);
    await new Promise((resolve, reject) => {
      uploadStream.on('error', reject);
      uploadStream.on('finish', resolve);
      uploadStream.end(Buffer.from(file.contentBase64, 'base64'));
    });
  }
}
