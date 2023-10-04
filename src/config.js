/**
*
* @licstart  The following is the entire license notice for the JavaScript code in this file.
*
* RESTful API for Melinda
*
* Copyright (C) 2018-2019, 2023 University Of Helsinki (The National Library Of Finland)
*
* This file is part of melinda-rest-api-http
*
* melinda-rest-api-http program is free software: you can redistribute it and/or modify
* it under the terms of the GNU Affero General Public License as
* published by the Free Software Foundation, either version 3 of the
* License, or (at your option) any later version.
*
* melinda-rest-api-http is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU Affero General Public License for more details.
*
* You should have received a copy of the GNU Affero General Public License
* along with this program.  If not, see <http://www.gnu.org/licenses/>.
*
* @licend  The above is the entire license notice
* for the JavaScript code in this file.
*
*/

import {parseBoolean} from '@natlibfi/melinda-commons';
import {readEnvironmentVariable} from '@natlibfi/melinda-backend-commons';
import {CONVERSION_FORMATS} from '@natlibfi/melinda-rest-api-commons';

export const httpPort = readEnvironmentVariable('HTTP_PORT', {defaultValue: '8080'});
export const enableProxy = readEnvironmentVariable('ENABLE_PROXY', {defaultValue: false, format: v => parseBoolean(v)});

export const xServiceURL = readEnvironmentVariable('ALEPH_X_SVC_URL');
export const userLibrary = readEnvironmentVariable('ALEPH_USER_LIBRARY');

export const ownAuthzURL = readEnvironmentVariable('OWN_AUTHZ_URL');
export const ownAuthzApiKey = readEnvironmentVariable('OWN_AUTHZ_API_KEY');

export const sruUrl = readEnvironmentVariable('SRU_URL');

// Amqp variables to priority
export const amqpUrl = readEnvironmentVariable('AMQP_URL', {defaultValue: 'amqp://127.0.0.1:5672/'});

// Mongo variables to bulk
export const mongoUri = readEnvironmentVariable('MONGO_URI', {defaultValue: 'mongodb://127.0.0.1:27017/db'});

export const pollWaitTime = readEnvironmentVariable('POLL_WAIT_TIME', {defaultValue: 100, format: v => Number(v)});

export const recordType = readEnvironmentVariable('RECORD_TYPE', {defaultValue: 'bib'});

export const requireAuthForRead = readEnvironmentVariable('REQUIRE_AUTH_FOR_READ', {defaultValue: false, format: v => parseBoolean(v)});
export const requireKVPForWrite = readEnvironmentVariable('REQUIRE_KVP_FOR_WRITE', {defaultValue: false, format: v => parseBoolean(v)});

export const CONTENT_TYPES = [
  {contentType: 'application/json', conversionFormat: CONVERSION_FORMATS.JSON, allowPrio: true, allowBulk: true},
  {contentType: 'application/marc', conversionFormat: CONVERSION_FORMATS.ISO2709, allowPrio: true, allowBulk: true},
  {contentType: 'application/xml', conversionFormat: CONVERSION_FORMATS.MARCXML, allowPrio: true, allowBulk: true},
  {contentType: 'application/alephseq', conversionFormat: CONVERSION_FORMATS.ALEPHSEQ, allowPrio: false, allowBulk: true}
];

export const DEFAULT_ACCEPT = readEnvironmentVariable('DEFAULT_ACCEPT', {defaultValue: 'application/json'});

