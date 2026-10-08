import type { WriteStream } from 'node:tty';
import { readFileSync } from 'node:fs';
import { getSystemErrorName } from 'node:util';
function dimensions(stream: WriteStream): string {
  return `${stream.columns ?? 'none'}:${stream.rows ?? 'none'}:${stream.isTTY ?? 'none'}`;
}
console.log(dimensions(process.stdout), dimensions(process.stderr));
console.log(process.stdout.columns ?? 'none', process.stderr.rows ?? 'none');
try { process.stdout.getWindowSize(); } catch (error) { console.log(error instanceof TypeError); }
try { readFileSync('missing-terminal-error-fixture', 'utf8'); } catch (error) {
  const details = error as NodeJS.ErrnoException;
  console.log(details.code, details.syscall, details.path, getSystemErrorName(details.errno!) === details.code);
  console.log((error as Error & { code?: string }).code, error instanceof Error);
}
const output = process.stdout;
console.log(output.columns ?? 80, output.isTTY ?? false);
const width = output.columns ?? 'auto';
console.log(width);
function selectedWidth() { return output.columns ?? 'auto'; }
console.log(selectedWidth());
