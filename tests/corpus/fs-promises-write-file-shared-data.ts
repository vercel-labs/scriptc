import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The options record of writeFile/appendFile over SharedArrayBuffer views:
// in the worker-enabled build shared storage is copied before its bytes
// go to write(2), and the copy has to live until the write returns. A
// worker thread writes its own shared view to the sibling path, so both
// threads exercise the snapshot.
const path = join(tmpdir(), `fs-promises-write-file-shared-data-${process.pid}.bin`);

async function mainThread(): Promise<void> {
  const view = new Uint8Array(new SharedArrayBuffer(6));
  view.set([0x66, 0x73, 0x70, 0x00, 0x01, 0x02]);
  const worker = new Worker(new URL(import.meta.url), { workerData: path });
  const workerHex = new Promise<string>((resolve) => worker.once("message", (hex) => resolve(hex as string)));
  const exited = new Promise<number>((resolve) => worker.once("exit", (code) => resolve(code)));
  console.log("worker", await workerHex);
  await writeFile(path, view.subarray(0, 5), { flag: "w", mode: 0o600 });
  console.log("write", (await readFile(path)).toString("hex"));
  view.set([0x21, 0x0a]);
  await appendFile(path, view.subarray(0, 2), { flag: "a" });
  console.log("append", (await readFile(path)).toString("hex"));
  console.log("exit", await exited);
  await rm(path, { force: true });
}

async function workerThread(target: string): Promise<void> {
  const view = new Uint8Array(new SharedArrayBuffer(3));
  view.set([0x61, 0x62, 0x63]);
  const sibling = `${target}.worker`;
  await writeFile(sibling, view, { flag: "w" });
  await appendFile(sibling, view, { flag: "a" });
  const written = await readFile(sibling);
  parentPort!.postMessage(written.toString("hex"));
  await rm(sibling, { force: true });
}

if (isMainThread) {
  mainThread();
} else {
  workerThread(String(workerData));
}
