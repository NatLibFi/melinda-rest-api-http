# Melinda REST API for ILS integration 
![Version](https://img.shields.io/github/package-json/v/NatLibFi/melinda-rest-api-http.svg)
![Node Version](https://img.shields.io/badge/dynamic/json.svg?url=https%3A%2F%2Fraw.githubusercontent.com%2FNatLibFi%2Fmelinda-rest-api-http%2Fmaster%2Fpackage.json&label=node&query=$.engines.node)

Melinda REST API for ILS integration

### Environment variables
| Name                  | Mandatory | Default                      |
|-----------------------|-----------|------------------------------|
| ALEPH_USER_LIBRARY    | Yes       |                              |
| ALEPH_X_SVC_URL       | Yes       |                              |
| ENABLE_PROXY          | Yes       |                              |
| OWN_AUTHZ_API_KEY     | Yes       |                              |
| OWN_AUTHZ_URL         | Yes       |                              |
| SRU_URL               | Yes       |                              |
| AMQP_URL              | No        | amqp://127.0.0.1:5672/       |
| HTTP_PORT             | No        | 8080                         |
| MONGO_URI             | No        | mongodb://127.0.0.1:27017/db |
| POLL_WAIT_TIME        | No        | 100                          |
| LOG_LEVEL             | No        | info                         |
| RECORD_TYPE           | No        | bib                          |
| REQUIRE_AUTH_FOR_READ | No        | false                        |
| REQUIRE_KVP_FOR_WRITE | No        | false                        |
| DEFAULT_ACCEPT        | No        | application/json             |
| FIX_TYPES             | No        | UNDEL,DELET                  |
| ALLOWED_LIBS          | No        | []                           |

### ApiDoc
https://bib-rest.api.melinda.kansalliskirjasto.fi/swagger/

## TypeScript toolchain

The source is TypeScript (Node >= 24, native type stripping for tests).

- `npm run build` runs `tsc` (`tsconfig.json`): `src/` -> `dist/`, emitting
  `.js` + `.js.map` + `.d.ts` + `.d.ts.map` for every module, then copies
  `src/api.json` and `src/api.yaml` into `dist/`. The published entry point
  stays `./dist/index.js`; the `.d.ts` files are additive for TypeScript
  consumers.
- `npm run typecheck` runs `tsc -p tsconfig.test.json` (typechecks `src/`
  and `test/`, no emit).
- `npm test` runs `npm run lint` then `npm run typecheck` then
  `npm run test:base` (what CI runs). Tests are `.ts` files run directly by
  `node --test` (no loader); `test:base` enforces coverage thresholds of
  88/88/90 (lines/branches/functions) over `src/`.

## License and copyright

Copyright (c) 2018-2026 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **MIT** or any later version.
