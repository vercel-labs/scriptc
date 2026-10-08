import type { WriteStream } from 'node:tty';
import { isatty } from 'node:tty';
function dimensions(stream: WriteStream): string {
  const columns = stream.columns;
  const rows = stream.rows;
  return `${columns ?? 'none'}:${rows ?? 'none'}:${stream.isTTY ?? 'none'}`;
}
const out = process.stdout;
const err = process.stderr;
console.log(dimensions(out), dimensions(err));
console.log(process.stdin.isTTY, out.isTTY, err.isTTY);
console.log(out.columns, err.rows, isatty(1), isatty(2));
let reads = 0;
function output(): WriteStream { reads++; return out; }
console.log(output().columns ?? 80, reads);
try { out.getWindowSize(); } catch (error) { console.log(error instanceof TypeError); }

console.log(isatty(-1), isatty(0.5), isatty(NaN), isatty(Infinity), isatty(2147483648));
