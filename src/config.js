
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

export const fixTypes = readEnvironmentVariable('FIX_TYPES', {defaultValue: ['DELET', 'UNDEL']});

// We default allowedLibs to empty array for backwards compatibility, as it is anyways checked in aleph-record-load-api
export const allowedLibs = readEnvironmentVariable('ALLOWED_LIBS', {defaultValue: []});
