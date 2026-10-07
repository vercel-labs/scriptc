import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rename, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (isMainThread) {
  const tasks: Promise<string>[] = [];
  for (let id = 0; id < 4; id++) {
    tasks.push(new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {workerData: id});
      let message = "";
      worker.once("message", (value: string) => { message = value; });
      worker.once("error", reject);
      worker.once("exit", (code: number) => {
        if (code !== 0) reject(new Error("worker failed"));
        else resolve(message);
      });
    }));
  }
  console.log(JSON.stringify(await Promise.all(tasks)));
} else {
  const id = workerData as number;
  const directory = mkdtempSync(join(tmpdir(), "worker-io-"));
  const before = join(directory, "before");
  const after = join(directory, "after");
  const watcher = watch(directory, () => {});
  watcher.close();
  writeFileSync(before, "file-" + id);
  await new Promise<void>((resolve, reject) => {
    rename(before, after, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const output = await new Promise<string>((resolve, reject) => {
    execFile("/bin/sh", ["-c", "printf child"], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const missing = await new Promise<boolean>((resolve) => {
    execFile("definitely-not-a-worker-command", (error) => resolve(error !== null));
  });
  const text = readFileSync(after, "utf8");
  rmSync(directory, {recursive: true});
  parentPort!.postMessage(text + ":" + output + ":" + missing);
}
