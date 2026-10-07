import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  const shared = { value: 17 };
  const buffer = new ArrayBuffer(16);
  const bytes = new Uint16Array(buffer, 4, 3);
  bytes[0] = 91;
  const root: Record<string, unknown> = {
    first: shared,
    second: shared,
    sparse: [, undefined, , shared],
    negativeZero: -0,
    nan: NaN,
    infinity: Infinity,
    text: "a\0😀",
    integer: 123456789012345678901234567890n,
    buffer,
    bytes,
    again: bytes,
    error: new TypeError("problem", { cause: shared }),
  };
  root.self = root;
  const worker = new Worker(new URL(import.meta.url), { workerData: root });
  worker.on("message", (value: unknown) => console.log(JSON.stringify(value)));
  worker.on("exit", (code: number) => console.log("exit", code, "original", bytes[0]));
} else {
  const root = workerData;
  root.bytes[0] = 42;
  parentPort!.postMessage({
    self: root.self === root,
    alias: root.first === root.second && root.sparse[3] === root.first,
    holes: [0 in root.sparse, 1 in root.sparse, 2 in root.sparse],
    numbers: [Object.is(root.negativeZero, -0), Number.isNaN(root.nan), root.infinity === Infinity],
    text: root.text,
    integer: String(root.integer),
    views: [root.bytes === root.again, root.bytes.buffer === root.buffer, root.bytes.byteOffset],
    error: [root.error instanceof TypeError, root.error.message, root.error.cause === root.first],
  });
}
