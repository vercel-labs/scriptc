// Element reads and writes of typed arrays over a SharedArrayBuffer, for every
// element kind, from the main thread and from a worker: each kind's
// conversion on write (wrapping, clamping, rounding to float32 and float16),
// NaN, -0 and the infinities, and values one thread writes and the other
// reads after a message. A worker loop that reads a flag without Atomics
// sees the main thread's write.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const KINDS = 10;

const VALUES = [0, -0, 1, -1, 1.5, 2.5, -2.5, 127, 128, 255, 256, -129, 65535, 65536, 2 ** 31, -(2 ** 31) - 1, 2 ** 32 + 7, 0.1, 1e40, -1e-50, NaN, Infinity, -Infinity];
const LENGTH = VALUES.length;

interface Views {
  i8: Int8Array;
  u8: Uint8Array;
  u8c: Uint8ClampedArray;
  i16: Int16Array;
  u16: Uint16Array;
  i32: Int32Array;
  u32: Uint32Array;
  f16: Float16Array;
  f32: Float32Array;
  f64: Float64Array;
}

/** One region of LENGTH elements per kind, each aligned to 8 bytes. */
function viewsOf(sab: SharedArrayBuffer): Views {
  const region = LENGTH * 8;
  return {
    i8: new Int8Array(sab, 0 * region, LENGTH),
    u8: new Uint8Array(sab, 1 * region, LENGTH),
    u8c: new Uint8ClampedArray(sab, 2 * region, LENGTH),
    i16: new Int16Array(sab, 3 * region, LENGTH),
    u16: new Uint16Array(sab, 4 * region, LENGTH),
    i32: new Int32Array(sab, 5 * region, LENGTH),
    u32: new Uint32Array(sab, 6 * region, LENGTH),
    f16: new Float16Array(sab, 7 * region, LENGTH),
    f32: new Float32Array(sab, 8 * region, LENGTH),
    f64: new Float64Array(sab, 9 * region, LENGTH),
  };
}

function show(x: number): string {
  return Object.is(x, -0) ? "-0" : String(x);
}

/** Writes VALUES (scaled by `scale`) through every view. */
function writeAll(v: Views, scale: number): void {
  for (let i = 0; i < LENGTH; i++) {
    const x = VALUES[i]! * scale;
    v.i8[i] = x;
    v.u8[i] = x;
    v.u8c[i] = x;
    v.i16[i] = x;
    v.u16[i] = x;
    v.i32[i] = x;
    v.u32[i] = x;
    v.f16[i] = x;
    v.f32[i] = x;
    v.f64[i] = x;
  }
}

/** Every element of every view, read one at a time, and a sum per view. */
function readAll(v: Views): string[] {
  const lines: string[] = [];
  const row = (kind: string, read: (i: number) => number): void => {
    const cells: string[] = [];
    for (let i = 0; i < LENGTH; i++) cells.push(show(read(i)));
    lines.push(`${kind}: ${cells.join(" ")}`);
  };
  row("Int8Array", (i) => v.i8[i]!);
  row("Uint8Array", (i) => v.u8[i]!);
  row("Uint8ClampedArray", (i) => v.u8c[i]!);
  row("Int16Array", (i) => v.i16[i]!);
  row("Uint16Array", (i) => v.u16[i]!);
  row("Int32Array", (i) => v.i32[i]!);
  row("Uint32Array", (i) => v.u32[i]!);
  row("Float16Array", (i) => v.f16[i]!);
  row("Float32Array", (i) => v.f32[i]!);
  row("Float64Array", (i) => v.f64[i]!);
  let total = 0;
  for (let i = 0; i < LENGTH; i++) total += v.i32[i]! + v.u16[i]! + (v.u8c[i]! | 0);
  lines.push(`integer total ${total}`);
  return lines;
}

if (isMainThread) {
  const sab = new SharedArrayBuffer(KINDS * LENGTH * 8 + 16);
  const views = viewsOf(sab);
  const flag = new Int32Array(sab, KINDS * LENGTH * 8, 2);
  writeAll(views, 1);
  console.log("main wrote, main reads");
  for (const line of readAll(views)) console.log(line);

  const worker = new Worker(new URL(import.meta.url), { workerData: sab });
  worker.on("message", (lines: string[]) => {
    if (lines.length === 1) {
      console.log(lines[0]);
      return;
    }
    console.log("main wrote, worker reads; worker wrote, main reads");
    for (const line of lines) console.log(line);
    for (const line of readAll(views)) console.log(line);
    flag[1] = 7;
    flag[0] = 1;
  });
} else {
  const sab = workerData as SharedArrayBuffer;
  const views = viewsOf(sab);
  const flag = new Int32Array(sab, KINDS * LENGTH * 8, 2);
  const seen = readAll(views);
  writeAll(views, -3);
  parentPort!.postMessage(seen);
  while (flag[0] === 0) {
    // Spin until the main thread's write is visible.
  }
  parentPort!.postMessage([`worker saw the flag, then ${flag[1]}`]);
}
