// TypedArray.prototype.set on SharedArrayBuffer views in a program with
// workers: the same cases on the main thread and in a worker (same element
// kinds with NaN payloads, overlapping ranges of one buffer, converted
// kinds), and a worker's set into a buffer that the main thread reads after
// a message.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

interface Job {
  shared: SharedArrayBuffer;
}

function hex(buffer: ArrayBufferLike): string {
  const words = new Uint32Array(buffer);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) out.push(words[i]!.toString(16));
  return out.join(",");
}

function cases(where: string): string[] {
  const lines: string[] = [];
  const bytes = new Uint8Array(new SharedArrayBuffer(12));
  bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  bytes.set(bytes.subarray(0, 8), 4);
  lines.push(`${where} overlap forward ${bytes.join(",")}`);
  bytes.set(bytes.subarray(5, 12), 0);
  lines.push(`${where} overlap backward ${bytes.join(",")}`);

  const floatBits = new Uint32Array(new SharedArrayBuffer(8));
  floatBits[0] = 0x7f800001;
  floatBits[1] = 0x7fc12345;
  const local = new Float32Array(2);
  local.set(new Float32Array(floatBits.buffer));
  const back = new Float32Array(new SharedArrayBuffer(12));
  back.set(local, 1);
  lines.push(`${where} f32 ${hex(local.buffer)} ${hex(back.buffer)}`);

  const halves = new Uint16Array(new SharedArrayBuffer(8));
  halves.set(new Uint16Array([65535, 1, 2]), 1);
  const signed = new Int16Array(4);
  signed.set(halves);
  const clamped = new Uint8ClampedArray(new SharedArrayBuffer(4));
  clamped.set(signed);
  lines.push(`${where} kinds ${halves.join(",")} ${signed.join(",")} ${clamped.join(",")}`);
  return lines;
}

if (isMainThread) {
  for (const line of cases("main")) console.log(line);
  const shared = new SharedArrayBuffer(16);
  const job: Job = { shared };
  const worker = new Worker(new URL(import.meta.url), { workerData: job });
  worker.on("message", (message: string) => {
    console.log(message);
    console.log("worker wrote", new Uint8Array(shared).join(","));
    void worker.terminate();
  });
} else {
  const { shared } = workerData as Job;
  const target = new Uint8Array(shared);
  target.set(new Uint8Array([9, 8, 7]), 2);
  target.set(target.subarray(2, 5), 10);
  parentPort!.postMessage(cases("worker").join("\n"));
}
