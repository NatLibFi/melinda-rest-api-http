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
| FIX_TYPES             | No        | UNDEL,DELET

### ApiDoc
https://bib-rest.api.melinda.kansalliskirjasto.fi/swagger/

## License and copyright

Copyright (c) 2018-2025 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **MIT** or any later version.
