// tsc-clean misuses of the standard-library surface: each line below is
// valid TypeScript against the ambient declarations but outside the
// supported lowering (most library, island-backed, string, and
// number functions have no value form; descriptor-backed Node functions
// are the explicit exception; `process` itself is not a first-class value).
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
const read = readFileSync; console.log(read);
const exit = process.exit;
const p = process;
const env = process.env;
const flo = Math.floor; // fixed-arity Math functions have native value forms
const upper = "abc".toUpperCase;
const fix = (1.5).toFixed;
const pf = parseFloat;
// Options-sensitive filesystem APIs remain call-only. TypeScript admits
// these narrower functions into wider callback slots, but a native adapter
// would discard the mode argument and create files/directories with default
// permissions instead of the requested restrictive permissions.
function takeSyncWriter(writer: (path: string, data: string, options: { mode: number }) => void): void {
  writer("/tmp/scriptc-secure-sync", "secret", { mode: 0o600 });
}
function takeAsyncWriter(writer: (path: string, data: string, options: { mode: number }) => Promise<void>): void {
  void writer("/tmp/scriptc-secure-async", "secret", { mode: 0o600 });
}
function takeMkdir(mkdir: (path: string, options: { mode: number }) => void): void {
  mkdir("/tmp/scriptc-secure-dir", { mode: 0o700 });
}
function takeOpen(open: (path: string, flags: string, mode: number) => number): void {
  open("/tmp/scriptc-secure-open", "w", 0o600);
}
takeSyncWriter(writeFileSync);
takeAsyncWriter(writeFile);
takeMkdir(mkdirSync);
takeOpen(openSync);
// Reached: every unsafe value use above must retain its compile-time fence.
