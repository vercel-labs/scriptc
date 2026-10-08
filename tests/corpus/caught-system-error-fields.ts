import { readFileSync, mkdirSync, copyFileSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { getSystemErrorName } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
interface Failure { code?: string; errno?: number; syscall?: string; path?: string; dest?: string; }
function code(error: unknown): string { return (error as Failure).code ?? 'none'; }
const root = mkdtempSync(join(tmpdir(), 'scriptc-error-fields-'));
const missing = join(root, 'missing.txt');
const destination = join(root, 'output.txt');
try {
  try { readFileSync(missing, 'utf8'); } catch (error: unknown) {
    const details = error as Failure;
    console.log(Object.keys(error as object).join(','));
    const typed = error as NodeJS.ErrnoException;
    console.log(code(error), details.syscall, details.path === missing, details.dest === undefined);
    console.log(typed.code, typed.syscall, typed.path === missing, getSystemErrorName(typed.errno!) === typed.code);
    console.log((error as Error & { code?: string }).code, error instanceof Error);
    if (error instanceof Error) console.log('code' in error);
    try { throw error; } catch (again) { console.log(again === error, code(again)); }
  }
  try { mkdirSync(root); } catch (error) {
    const details = error as Failure;
    console.log(details.code, details.syscall, details.path === root, getSystemErrorName(details.errno!) === details.code);
  }
  try { copyFileSync(missing, destination); } catch (error) {
    const details = error as Failure;
    console.log(details.code, details.syscall, details.path === missing, details.dest === destination);
  }
  try { closeSync(1000000); } catch (error) {
    const details = error as Failure;
    console.log(details.code, details.syscall, details.path === undefined, getSystemErrorName(details.errno!) === details.code);
  }
  try { throw new Error('plain'); } catch (error) {
    const details = error as Failure;
    console.log(code(error), details.errno, details.syscall, details.path, details.dest);
  }
  class LocalError extends Error { code = 'LOCAL'; errno = 3; syscall = 'custom'; }
  try { throw new LocalError('local'); } catch (error) {
    const details = error as Failure;
    console.log(code(error), details.errno, details.syscall);
  }
} finally { rmSync(root, { recursive: true }); }
