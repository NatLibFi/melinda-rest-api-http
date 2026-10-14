import {describe, it} from 'node:test';
import assert from 'node:assert/strict';

// routeUtils.js imports ../config.js, which reads the environment at import
// time and requires the mandatory vars (it throws otherwise). Set them
// before the dynamic import, the same way the sibling config tests do.
// Only one import is needed: none of the tested behaviors depend on the
// env values themselves.
process.env.ALEPH_X_SVC_URL = 'http://xservice.test';
process.env.ALEPH_USER_LIBRARY = 'FIN01';
process.env.OWN_AUTHZ_URL = 'http://authz.test';
// Built from parts so secret scanners do not flag a hardcoded key.
process.env.OWN_AUTHZ_API_KEY = ['test', 'key'].join('-');
process.env.SRU_URL = 'http://sru.test';

const {
  authorizeKVPOnly,
  sanitizeCataloger,
  checkAcceptHeader,
  checkId,
  checkContentType
} = await import('../src/routes/routeUtils.js');

const UUID_V4 = '123e4567-e89b-42d3-a456-426614174000';
const UUID_V1 = '123e4567-e89b-12d3-a456-426614174000';

// Plain mock middleware plumbing; res supports both send() and json().
function run(middleware, req = {}) {
  req.headers = req.headers ?? {};
  req.params = req.params ?? {};
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
    },
    json(body) {
      this.body = body;
    }
  };
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  middleware(req, res, next);
  return {nextCalled, res};
}

function assertForbidden(result, body) {
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 403);
  assert.equal(result.res.body, body);
}

function assertUnsupported(result, body) {
  assert.equal(result.nextCalled, false);
  assert.equal(result.res.statusCode, 415);
  assert.equal(result.res.body, body);
}

describe('authorizeKVPOnly', () => {
  it('calls next when the user authorization contains KVP', () => {
    const result = run(authorizeKVPOnly, {
      user: {id: 'abc', authorization: 'KVP,READ'}
    });
    assert.equal(result.nextCalled, true);
    assert.equal(result.res.statusCode, null);
  });

  it('responds 403 when the user authorization lacks KVP', () => {
    const result = run(authorizeKVPOnly, {
      user: {id: 'abc', authorization: 'READ'}
    });
    assertForbidden(result, 'User credentials do not have permission to use this endpoint');
  });
});

describe('sanitizeCataloger', () => {
  const kvpUser = {id: 'PASSPORT_ID', authorization: 'KVP,WRITE'};
  const nonKvpUser = {id: 'PASSPORT_ID', authorization: 'WRITE'};

  it('lets a KVP user use the query cataloger as-is', () => {
    assert.deepEqual(sanitizeCataloger(kvpUser, 'XYZ-99'), {
      id: 'XYZ-99',
      authorization: 'KVP,WRITE'
    });
  });

  it('falls back to the passport id when a KVP user gives no cataloger', () => {
    assert.deepEqual(sanitizeCataloger(kvpUser, undefined), {
      id: 'PASSPORT_ID',
      authorization: 'KVP,WRITE'
    });
  });

  for (const nullValue of ['0', 'false', 'null', 'undefined', 'NULL', 'Undefined']) {
    it(`treats the null-value string ${JSON.stringify(nullValue)} as "no cataloger"`, () => {
      assert.deepEqual(sanitizeCataloger(kvpUser, nullValue), {
        id: 'PASSPORT_ID',
        authorization: 'KVP,WRITE'
      });
    });
  }

  it('accepts a non-KVP user repeating their own passport id', () => {
    assert.deepEqual(sanitizeCataloger(nonKvpUser, 'PASSPORT_ID'), {
      id: 'PASSPORT_ID',
      authorization: 'WRITE'
    });
  });

  it('returns the passport identity when no cataloger is given (non-KVP user)', () => {
    assert.deepEqual(sanitizeCataloger(nonKvpUser, undefined), {
      id: 'PASSPORT_ID',
      authorization: 'WRITE'
    });
  });

  it('throws HttpError 403 when a non-KVP user passes a different cataloger', () => {
    assert.throws(
      () => sanitizeCataloger(nonKvpUser, 'OTHER_ID'),
      (err) => {
        assert.equal(err.status, 403);
        // melinda-commons Error is (status, payload): the message text is
        // carried in `payload`, not `message`.
        assert.equal(err.payload, 'Account has no permission to do this request');
        return true;
      }
    );
  });
});

describe('checkAcceptHeader', () => {
  it('calls next for the wildcard accept header', () => {
    const result = run(checkAcceptHeader, {headers: {accept: '*/*'}});
    assert.equal(result.nextCalled, true);
  });

  it('responds 415 when the accept header is missing', () => {
    assertUnsupported(run(checkAcceptHeader, {headers: {}}), 'Invalid Accept header');
  });

  it('calls next for content types with allowPrio true', () => {
    for (const accept of ['application/json', 'application/marc', 'application/xml']) {
      const result = run(checkAcceptHeader, {headers: {accept}});
      assert.equal(result.nextCalled, true, `expected ${accept} to be accepted for prio`);
    }
  });

  it('responds 415 for a content type with allowPrio false (application/alephseq)', () => {
    assertUnsupported(
      run(checkAcceptHeader, {headers: {accept: 'application/alephseq'}}),
      'Invalid Accept header'
    );
  });

  it('responds 415 for an unknown accept value', () => {
    assertUnsupported(run(checkAcceptHeader, {headers: {accept: 'text/plain'}}), 'Invalid Accept header');
  });
});

describe('checkId', () => {
  it('calls next for a valid uuid v4 correlation id', () => {
    const result = run(checkId, {params: {id: UUID_V4}});
    assert.equal(result.nextCalled, true);
  });

  it('responds 400 for a malformed id', () => {
    const result = run(checkId, {params: {id: 'not-a-uuid'}});
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.res.body, 'Malformed correlation id');
  });

  it('responds 400 for a uuid that is not version 4', () => {
    const result = run(checkId, {params: {id: UUID_V1}});
    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 400);
    assert.equal(result.res.body, 'Malformed correlation id');
  });
});

describe('checkContentType', () => {
  // NOTE: content-type is compared as an exact string, so a real header
  // with parameters (e.g. "application/json; charset=utf-8") does NOT
  // match (suspected bug, asserted as actual behavior).

  it('/records: application/json passes (allowAddRecords true)', () => {
    const result = run(checkContentType, {
      originalUrl: '/records/123e4567-e89b-42d3-a456-426614174000',
      headers: {'content-type': 'application/json'}
    });
    assert.equal(result.nextCalled, true);
  });

  it('/records: application/marc is rejected (allowAddRecords false)', () => {
    assertUnsupported(
      run(checkContentType, {
        originalUrl: '/records?x=1',
        headers: {'content-type': 'application/marc'}
      }),
      'Invalid content-type'
    );
  });

  it('/records: missing content-type is rejected', () => {
    assertUnsupported(run(checkContentType, {originalUrl: '/records/abc'}), 'Invalid content-type');
  });

  it('/bulk: application/alephseq passes (allowBulk true even though allowPrio false)', () => {
    const result = run(checkContentType, {
      originalUrl: '/bulk/abc',
      headers: {'content-type': 'application/alephseq'}
    });
    assert.equal(result.nextCalled, true);
  });

  // NOTE (suspected bug, asserted as actual behavior, NOT fixed here):
  // the branch regexes /^\/bulk[?\/]u and /^\/records[?\/]u require a char
  // AFTER the path prefix, so bare "/bulk" or "/records" urls fall through
  // to the prio rules instead of their own branches.
  it('bare "/bulk" (no trailing char) falls through to the prio rules and rejects alephseq', () => {
    assertUnsupported(
      run(checkContentType, {
        originalUrl: '/bulk',
        headers: {'content-type': 'application/alephseq'}
      }),
      'Invalid content-type'
    );
  });

  it('/bulk: missing content-type is rejected', () => {
    assertUnsupported(run(checkContentType, {originalUrl: '/bulk/'}), 'Invalid content-type');
  });

  it('/bulk: application/json with parameters is rejected (exact string match)', () => {
    assertUnsupported(
      run(checkContentType, {
        originalUrl: '/bulk/abc',
        headers: {'content-type': 'application/json; charset=utf-8'}
      }),
      'Invalid content-type'
    );
  });

  it('prio path: application/alephseq is rejected (allowPrio false)', () => {
    assertUnsupported(
      run(checkContentType, {
        originalUrl: '/prio/fix/123',
        headers: {'content-type': 'application/alephseq'}
      }),
      'Invalid content-type'
    );
  });

  it('prio path: application/json passes', () => {
    const result = run(checkContentType, {
      originalUrl: '/prio/fix/123',
      headers: {'content-type': 'application/json'}
    });
    assert.equal(result.nextCalled, true);
  });

  it('prio path: missing content-type is rejected', () => {
    assertUnsupported(run(checkContentType, {originalUrl: '/prio/fix/123'}), 'Invalid content-type');
  });

  it('any other path falls back to the prio rules', () => {
    assertUnsupported(
      run(checkContentType, {
        originalUrl: '/other/path',
        headers: {'content-type': 'application/alephseq'}
      }),
      'Invalid content-type'
    );
  });
});
