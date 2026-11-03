// Temporary ambient type declarations for @natlibfi/passport-melinda-aleph
// (JS-only, ships no .d.ts). Replace this file with the dependency's real
// types once a typed release is adopted.
declare module '@natlibfi/passport-melinda-aleph' {
  import {BasicStrategy} from 'passport-http';
  export class AlephStrategy extends BasicStrategy {
    constructor(options: {
      xServiceURL: string;
      userLibrary: string;
      ownAuthzURL: string;
      ownAuthzApiKey: string;
    });
  }
}
