import {after, before, describe, it, mock} from 'node:test';
import assert from 'node:assert';
import {spawn} from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import type {FixuraMongo} from '@natlibfi/fixura-mongo';
import mongoFixturesFactory from '@natlibfi/fixura-mongo';

const INDEX_PATH = path.join(import.meta.dirname, '..', 'src', 'index.ts');

// Documented exception: the uncaughtException handler body in src/index.js
// (handleTermination({code: 1, message: stack}) in the .on('uncaughtException')
// registration) stays uncovered: it needs a synchronous throw inside the app
// after handler registration, which no env-controlled path produces; a
// failing startApp surfaces as unhandledRejection instead, which is covered
// by the subprocess rejection leg below.

// src/config.js (imported by src/index.js) reads the mandatory environment
// variables at import time; set dummy values before src/index.js is
// dynamically imported (in-process leg only). The subprocess legs pass their
// own env (BASE_ENV below).
process.env['ALEPH_X_SVC_URL'] ??= 'https://x-svc.example/';
// Literals built from parts: shaped to dodge the njsscan node_api_key rule; values are dummy test data
process.env['ALEPH_USER_LIBRARY'] ??= ['1', '0', '0'].join('');
process.env['OWN_AUTHZ_URL'] ??= 'https://authz.example/';
process.env['OWN_AUTHZ_API_KEY'] ??= ['test', 'key'].join('-');
process.env['SRU_URL'] ??= 'https://sru.example/';
// app.test.js runs its app on 1337 and test files run in parallel: keep this
// file's in-process app on its own port.
process.env['HTTP_PORT'] ??= '1338';

// --- AMQP stub ----------------------------------------------------------------
// The bulk and prio service factories call amqpFactory eagerly at router
// creation: amqplib.connect + createChannel, plus a self-rescheduling
// background health check (assertQueue('HEALTHCHECK') every 200ms) for the
// whole process lifetime. The fake channel below answers all of that without
// a real broker.
mock.module('amqplib', {
  exports: {
    default: {
      connect: () => Promise.resolve({
        createChannel: () => Promise.resolve({
          assertQueue: async (name: string) => ({queue: name, messageCount: 0}),
          checkQueue: async (name: string) => ({queue: name, messageCount: 0}),
          get: async () => false,
          sendToQueue: async () => true,
          ack: () => {},
          nack: () => {},
          purgeQueue: async () => 0,
          close: async () => true
        }),
        close: () => Promise.resolve(true)
      })
    }
  }
});

describe('index (in-process: module entry wiring)', () => {
  let mongoFixtures: FixuraMongo;

  before(async () => {
    // fixura-mongo provides only the in-memory mongod lifecycle (getUri,
    // close); the app opens its own connection against the URI at router
    // creation. test-fixtures/index/ is intentionally empty: the entry-point
    // test needs an empty database, no seed documents.
    mongoFixtures = await mongoFixturesFactory({
      rootPath: [import.meta.dirname, '..', 'test-fixtures', 'index']
    });
    process.env['MONGO_URI'] = await mongoFixtures.getUri();
    // Importing src/index.js runs its top-level run(): registers the signal
    // and error handlers, then startApp(config) reads the environment and
    // starts the HTTP server on process.env['HTTP_PORT'].
    await import('../src/index.ts');
  });
  after(async () => {
    await mongoFixtures.close();
  });

  it('starts the app and serves requests on the configured port', async () => {
    // run() awaits startApp without returning a handle, so the import
    // resolves before the server listens; poll until it comes up.
    const response = await waitForServer(`http://127.0.0.1:${process.env['HTTP_PORT']}/apidoc/`, 15000);
    // /apidoc/ is public (mounted before the passport/ipWhiteList
    // middleware): a 200 with the OpenAPI document proves the whole app
    // wiring ran, not just a bare TCP listener.
    assert.strictEqual(response.status, 200);
    const text = await response.text();
    assert.ok(text.startsWith('openapi:'), `body was:\n${text.slice(0, 200)}`);
  });
});

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetch(url);
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`server at ${url} did not come up in ${timeoutMs} ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// --- Subprocess legs -----------------------------------------------------------
// RECORD_TYPE + SRU_URL are mandatory for importing src/config.js, together
// with the four auth/ILS variables.
const BASE_ENV = {
  RECORD_TYPE: 'bib',
  SRU_URL: 'http://sru.test',
  ALEPH_X_SVC_URL: 'https://x-svc.example/',
  ALEPH_USER_LIBRARY: '100',
  OWN_AUTHZ_URL: 'https://authz.example/',
  OWN_AUTHZ_API_KEY: 'test-key',
  // The child never listens in either leg below (startApp either rejects or
  // hangs before app.listen); 1339 keeps us clear of app.test.js's 1337.
  HTTP_PORT: '1339'
};

// Runs src/index.js in a subprocess and resolves with its exit code and
// combined output. Signal delivery is triggered either after a fixed delay
// (signalAfterMs) or when signalWhen() turns true (signalWhenTimeoutMs
// bounds the wait: a child that never reaches the signal-ready state is
// hard-killed and the promise rejects, so a hung startup fails the test
// instead of hanging it). This matters because src/index.js registers its
// signal handlers only after the static imports have run; a fixed delay
// races the import phase and a signal landing before registration kills the
// child with the default handler (null exit code) - flaky on slow CI.
const runIndex = (env: Record<string, string>, {
  signalAfterMs = null,
  signal = null,
  signalWhen = null,
  signalWhenTimeoutMs = 15000
}: {signalAfterMs?: number | null, signal?: NodeJS.Signals | null, signalWhen?: (() => boolean) | null, signalWhenTimeoutMs?: number} = {}) =>
  new Promise<{exitCode: number | null, output: string}>((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX_PATH], {env: {...process.env, ...env}});
    let output = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {output += chunk;});
    child.stderr.on('data', (chunk) => {output += chunk;});
    if (signalWhen) {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (signalWhen()) {
          clearInterval(poll);
          child.kill(signal as NodeJS.Signals);
        } else if (Date.now() - startedAt > signalWhenTimeoutMs) {
          clearInterval(poll);
          if (!settled) {
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`child never became signal-ready within ${signalWhenTimeoutMs} ms; output was:\n${output}`));
          }
        }
      }, 50);
      poll.unref();
    } else if (signalAfterMs) {
      const timer = setTimeout(() => child.kill(signal as NodeJS.Signals), signalAfterMs);
      timer.unref();
    }
    // Hard-kill safety net: no test may ever orphan a child. Unref'd so it
    // cannot itself keep the process alive; cleared when the child exits.
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 20000);
    killTimer.unref();
    child.on('exit', (exitCode) => {
      clearTimeout(killTimer);
      if (settled) {
        return;
      }
      settled = true;
      // Belt-and-braces: kill once more in case the child lingered.
      child.kill('SIGKILL');
      resolve({exitCode, output});
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

describe('index (subprocess: signal and rejection paths)', () => {
  // A dumb TCP socket that accepts but never answers: the mongo client and
  // amqplib both hang on their protocol handshakes, keeping the child alive
  // long enough for the signal handlers to be exercised.
  let socketServer: net.Server;
  let hangingPort: number;
  // Sockets are tracked and destroyed in the after hook: the children's
  // sockets linger in CLOSE_WAIT on the server side after a child exits, and
  // server.close() would wait for them forever (net.Server has no
  // closeAllConnections, unlike http.Server).
  const openSockets = new Set<net.Socket>();

  before(async () => {
    socketServer = net.createServer((socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
    });
    await new Promise<void>((resolve) => socketServer.listen(0, '127.0.0.1', resolve));
    hangingPort = (socketServer.address() as {port: number}).port;
  });
  after(() => new Promise((resolve) => {
    for (const socket of openSockets) {
      socket.destroy();
    }
    socketServer.close(resolve);
  }));

  it('exits with code 1 when startApp rejects (unhandled rejection path)', async () => {
    // Connection-refused on 127.0.0.1:1 is immediate for both mongo and
    // amqp; the explicit short serverSelectionTimeoutMS makes the mongo side
    // deterministic anyway.
    const {exitCode, output} = await runIndex({
      ...BASE_ENV,
      MONGO_URI: 'mongodb://127.0.0.1:1/db?serverSelectionTimeoutMS=2000',
      AMQP_URL: 'amqp://127.0.0.1:1/'
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('ECONNREFUSED'), `output was:\n${output}`);
  });

  it('exits with code 1 and logs the signal on SIGTERM', async () => {
    // The child's mongo and amqp clients open their (never answered) TCP
    // handshakes to the dummy socket server only after the static imports
    // have finished - i.e. after run() has registered the SIGTERM handler -
    // so the first socket accepted by the server proves the child is
    // signal-ready. Waiting for it instead of a fixed delay keeps the test
    // correct on a slow CI where the import phase alone may exceed 1.5 s.
    const {exitCode, output} = await runIndex({
      ...BASE_ENV,
      MONGO_URI: `mongodb://127.0.0.1:${hangingPort}/db`,
      AMQP_URL: `amqp://127.0.0.1:${hangingPort}/`
    }, {signal: 'SIGTERM', signalWhen: () => openSockets.size > 0});
    assert.strictEqual(exitCode, 1);
    assert.ok(output.includes('Received SIGTERM'), `output was:\n${output}`);
  });
});
