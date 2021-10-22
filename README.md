# Melinda REST API for ILS integration 
Melinda REST API for ILS integration

### Environment variables
| Name               | Mandatory | Default                      |
|--------------------|-----------|------------------------------|
| ALEPH_USER_LIBRARY | Yes       |                              |
| ALEPH_X_SVC_URL    | Yes       |                              |
| ENABLE_PROXY       | Yes       |                              |
| OWN_AUTHZ_API_KEY  | Yes       |                              |
| OWN_AUTHZ_URL      | Yes       |                              |
| SRU_URL_BIB        | Yes       |                              |
| AMQP_URL           | No        | amqp://127.0.0.1:5672/       |
| HTTP_PORT          | No        | 8080                         |
| MONGO_URI          | No        | mongodb://127.0.0.1:27017/db |
| POLL_WAIT_TIME     | No        | 100                          |
| LOG_LEVEL          | No        | info                         |

### ApiDoc
https://rest.api.melinda-test.kansalliskirjasto.fi/apidoc/v1/bib/

## License and copyright

Copyright (c) 2018-2021 **University Of Helsinki (The National Library Of Finland)**

This project's source code is licensed under the terms of **GNU Affero General Public License Version 3** or any later version.
