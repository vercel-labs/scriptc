// Counted loops over typed arrays backed by a SharedArrayBuffer in a program
// with workers: loops to a length and to a bound, ascending, descending and
// by two, reads and writes at the counter and next to it, nested loops, and
// each element type. The worker and the main thread run the same loops over
// the same shared memory, one after the other.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

interface Shared {
  bytes: Uint8Array;
  shorts: Int16Array;
  words: Uint32Array;
  ints: Int32Array;
  floats: Float32Array;
  doubles: Float64Array;
}

function codes(a: Uint8Array): void {
  for (let i = 0; i < a.length; ++i) {
    const x = a[i];
    if (x === 97) a[i] = 0;
    else if (x === 116) a[i] = 1;
    else if (x === 99) a[i] = 2;
    else a[i] = 3;
  }
}

function checksum(a: Uint8Array): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t = (t * 31 + a[i]!) % 1000003;
  return t;
}

function shiftLeft(a: Uint8Array): void {
  for (let i = 0; i < a.length - 1; i++) a[i] = a[i + 1]!;
}

function descend(a: Int16Array, n: number): number {
  let t = 0;
  for (let i = n - 1; i >= 0; i--) {
    a[i] = a[i]! - i * 3;
    t += a[i]!;
  }
  return t;
}

function everyOther(a: Uint32Array): number {
  let t = 0;
  for (let i = 0; i < a.length; i += 2) {
    a[i] = a[i]! * 2 + 4000000000;
    t += a[i]! % 1000;
  }
  return t;
}

function grid(a: Int32Array, n: number): number {
  let t = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t += a[i]! * a[j]! - j;
  return t;
}

function mix(f: Float32Array, d: Float64Array, n: number): number {
  for (let i = 0; i < n; i++) {
    f[i] = f[i]! * 0.5 + i;
    d[i] = d[i]! + f[i]! / 3;
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += d[i]!;
  return Math.round(t * 1000) / 1000;
}

function fill(s: Shared): void {
  const letters = [97, 116, 99, 103];
  let seed = 7;
  for (let i = 0; i < s.bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    s.bytes[i] = letters[(seed >> 16) % 4]!;
  }
  for (let i = 0; i < s.shorts.length; i++) s.shorts[i] = (i * 37) % 2000 - 1000;
  for (let i = 0; i < s.words.length; i++) s.words[i] = i * 2654435761;
  for (let i = 0; i < s.ints.length; i++) s.ints[i] = (i % 7) - 3;
  for (let i = 0; i < s.floats.length; i++) s.floats[i] = i / 4;
  for (let i = 0; i < s.doubles.length; i++) s.doubles[i] = i * 1.25;
}

function run(where: string, s: Shared): string {
  codes(s.bytes);
  const coded = checksum(s.bytes);
  shiftLeft(s.bytes);
  const shifted = checksum(s.bytes);
  const down = descend(s.shorts, s.shorts.length);
  const other = everyOther(s.words);
  const cells = grid(s.ints, 40);
  const mixed = mix(s.floats, s.doubles, s.floats.length);
  return `${where}: ${coded} ${shifted} ${down} ${other} ${cells} ${mixed} ${s.bytes[0]} ${s.words[2]}`;
}

function views(buffers: SharedArrayBuffer[]): Shared {
  return {
    bytes: new Uint8Array(buffers[0]!),
    shorts: new Int16Array(buffers[1]!),
    words: new Uint32Array(buffers[2]!),
    ints: new Int32Array(buffers[3]!),
    floats: new Float32Array(buffers[4]!),
    doubles: new Float64Array(buffers[5]!),
  };
}

if (isMainThread) {
  const buffers = [
    new SharedArrayBuffer(10007),
    new SharedArrayBuffer(2 * 515),
    new SharedArrayBuffer(4 * 333),
    new SharedArrayBuffer(4 * 40),
    new SharedArrayBuffer(4 * 129),
    new SharedArrayBuffer(8 * 129),
  ];
  const shared = views(buffers);
  fill(shared);
  const worker = new Worker(new URL(import.meta.url), { workerData: buffers });
  worker.on("message", (line: string) => {
    console.log(line);
    console.log(run("main", shared));
    fill(shared);
    console.log(run("main again", shared));
  });
} else {
  parentPort!.postMessage(run("worker", views(workerData as SharedArrayBuffer[])));
}
