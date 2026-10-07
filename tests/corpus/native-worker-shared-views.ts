import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
if (isMainThread) {
  const buffer = new SharedArrayBuffer(32);
  const values = new Int32Array(buffer);
  const view = new DataView(buffer, 16, 8);
  view.setInt32(0, 123, true);
  const worker = new Worker(new URL(import.meta.url), {workerData: {buffer, values, view}});
  worker.on("message", (value: unknown) => {
    if (value === "ready") {
      for (let i = 0; i < 10000; i++) Atomics.add(values, 0, 1);
      Atomics.store(values, 1, 1);
      Atomics.notify(values, 1);
    } else console.log(JSON.stringify(value));
  });
  worker.on("exit", (code: number) => console.log("exit", code, values[0], view.getInt32(0, true), buffer.byteLength));
} else {
  const data = workerData as {buffer: SharedArrayBuffer, values: Int32Array, view: DataView};
  const values = data.values;
  parentPort!.postMessage("ready");
  for (let i = 0; i < 10000; i++) Atomics.add(values, 0, 1);
  while (Atomics.load(values, 1) === 0) Atomics.wait(values, 1, 0);
  data.view.setInt32(0, data.view.getInt32(0, true) + 1, true);
  const alias = new Int32Array(data.buffer, 16, 1);
  parentPort!.postMessage({shared: data.buffer instanceof SharedArrayBuffer, alias: alias[0], same: data.values.buffer === data.buffer, offset: data.view.byteOffset});
}
