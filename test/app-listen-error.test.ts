import {mock, test} from 'node:test';
import {createServer as createNetServer} from 'node:net';
import express from 'express';
import {BasicStrategy} from 'passport-http';

// Express' app.listen is a raw pass-through to Node's server.listen: on a
// bind failure (EADDRINUSE) the callback is invoked with the error as its
// first argument. Before the error check in src/app.ts existed, that same
// callback logged the "Started" success message anyway and the process kept
// sitting alive (service clients hold the event loop) while serving nothing.
// This test drives the real startApp into an occupied port and pins the
// failure path: error logged, process.exit(1), no success message.

// --- Mocks (node:test module mocks, applied before the dynamic import) ----

interface Logged {debug: string[], verbose: string[], info: string[], warn: string[], error: string[]};
const logged: Logged = {debug: [], verbose: [], info: [], warn: [], error: []};

const createLoggerMock = () => ({
  debug: (m: string) => {logged.debug.push(m);},
  verbose: (m: string) => {logged.verbose.push(m);},
  info: (m: string) => {logged.info.push(m);},
  warn: (m: string) => {logged.warn.push(m);},
  error: (m: string) => {logged.error.push(m);}
});

mock.module('@natlibfi/melinda-commons', {
  exports: {
    Error: class Error extends globalThis.Error {
      code: number;

      payload: unknown;

      constructor(message: string, code = 500, payload: unknown = null) {
        super(message);
        this.code = code;
        this.payload = payload;
      }
    },
    createLogger: createLoggerMock,
    createExpressLogger: () => (_req: unknown, _res: unknown, next: any) => next(),
    parseBoolean: (v: unknown) => v === true || v === 'true' || v === 1 || v === '1'
  }
});

class MockAlephStrategy extends BasicStrategy {
  constructor() {
    super((_username: string, _password: string, done: any) => done(null, {id: '1', authorization: ['KVP']}));
    this.name = 'melinda';
  }
}

mock.module('@natlibfi/passport-melinda-aleph', {exports: {AlephStrategy: MockAlephStrategy}});

const trivialRouter = () => {
  const router = express.Router();
  router.get('/', (_req, res: any) => res.status(200).end());
  return router;
};

// The real routers build Mongo/Amqp/Sru services at construction time; none
// of them are relevant to the listen() call this test pins.
mock.module('../src/routes/index.ts', {
  exports: {
    createApiDocRouter: trivialRouter,
    createBulkRouter: trivialRouter,
    createLogsRouter: trivialRouter,
    createPrioRouter: trivialRouter
  }
});

// ---------------------------------------------------------------------------

const appModule = await import('../src/app.ts');
const startApp = appModule.default;

test('listen failure exits with code 1 and logs the error, not the success message', async t => {
  // Bind a real server on an ephemeral port so the listen under test fails
  // with EADDRINUSE.
  const holder = createNetServer();
  await new Promise<void>(resolve => holder.listen(0, resolve));
  const occupied = (holder.address() as any).port;

  const exitCalls: number[] = [];
  // process.exit(1) would kill the test process; capture it instead.
  t.mock.method(process, 'exit', ((code?: number) => {
    exitCalls.push(code ?? 0);
  }) as typeof process.exit);

  await startApp({
    httpPort: occupied, enableProxy: false,
    xServiceURL: 'https://x-svc.example/', userLibrary: '100',
    ownAuthzURL: 'https://authz.example/', ownAuthzApiKey: 'test-key',
    sruUrl: 'https://sru.example/', amqpUrl: 'amqp://127.0.0.1:5672/',
    mongoUri: 'mongodb://127.0.0.1:27017/db', pollWaitTime: 50,
    recordType: 'MARC21', requireAuthForRead: false, requireKVPForWrite: false,
    fixTypes: ['880Y'], allowedLibs: ['100'], ipWhiteList: []
  });

  await new Promise(resolve => setImmediate(resolve));

  t.assert.deepEqual(exitCalls, [1]);
  t.assert.equal(logged.error.length, 1);
  t.assert.match(logged.error[0] ?? '', new RegExp(`Failed to start HTTP server on port ${occupied}`));
  t.assert.equal(logged.info.some(m => m.startsWith('Started Melinda REST API')), false);

  await new Promise<void>(resolve => holder.close(() => resolve()));
});
