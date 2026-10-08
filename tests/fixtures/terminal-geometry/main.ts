import type { WriteStream } from 'node:tty';
const out = process.stdout;
function size(stream: WriteStream): [number, number] { return stream.getWindowSize(); }
function geometry(): number[] {
  const output = out.getWindowSize();
  const errors = size(process.stderr);
  if (!out.isTTY || !process.stderr.isTTY || process.stdin.isTTY !== undefined) throw new Error(`tty flags: ${out.isTTY},${process.stderr.isTTY},${process.stdin.isTTY}`);
  if (output[0] !== out.columns || output[1] !== process.stdout.rows) throw new Error('stdout geometry');
  if (errors[0] !== process.stderr.columns || errors[1] !== process.stderr.rows) throw new Error('stderr geometry');
  return [output[0], output[1], errors[0], errors[1]];
}
console.log(JSON.stringify(geometry()));
let ticks = 0;
const timer = setInterval(() => {
  const size = geometry();
  if (size[0] === 100 && size[1] === 52 && size[2] === 80 && size[3] === 24) {
    console.log(JSON.stringify(size));
    clearInterval(timer);
  } else if (++ticks > 500) {
    clearInterval(timer);
    process.exitCode = 1;
  }
}, 5);
