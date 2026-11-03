/**
 * Ambient type declaration for http-status (v2), which ships no .d.ts
 * files. Shorthand (any) on purpose: the module is a static
 * code->number map accessed with dot notation throughout this project,
 * which an index-signature type would clash with
 * (noPropertyAccessFromIndexSignature).
 */
declare module 'http-status';
