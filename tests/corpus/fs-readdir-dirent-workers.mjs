// fs.readdir's callback form answers Dirent values whose is*() methods sit on
// a cached Dirent prototype. Several workers read a directory with
// withFileTypes and then exit while the others are still reading, so the
// prototype has to be part of each thread's own runtime state: a process-wide
// one would be released by the first worker's exit cleanup while another
// worker still uses it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const root = path.join(os.tmpdir(), `scriptc-dirent-workers-${process.pid}`);

function readRound(dir, done) {
  fs.readdir(dir, { withFileTypes: true }, (error, entries) => {
    if (error) {
      done(`error ${error.code}`);
      return;
    }
    // Directory order is the filesystem's; sort so both processes print the
    // same line.
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rows = sorted.map(
      (entry) => `${entry.name}:${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}`,
    );
    const probes = sorted
      .map((entry) => {
        const onPrototype = typeof entry.isFile === "function" && typeof entry.isDirectory === "function";
        return `${onPrototype}:${entry.parentPath === dir}`;
      })
      .join(" ");
    done(`${rows.join(" ")} probes ${probes}`);
  });
}

if (isMainThread) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "alpha.txt"), "a");
  fs.writeFileSync(path.join(root, "beta.txt"), "b");
  fs.mkdirSync(path.join(root, "gamma"));
  const lines = [];
  let pending = 4;
  for (let worker = 0; worker < 4; worker++) {
    const child = new Worker(new URL(import.meta.url), {
      workerData: { dir: root, rounds: 15 + worker * 5 },
    });
    child.on("message", (message) => {
      lines[worker] = `worker ${worker}: ${message}`;
    });
    child.on("exit", () => {
      if (--pending > 0) return;
      for (const line of lines) console.log(line);
      fs.rmSync(root, { recursive: true, force: true });
      console.log("done");
    });
  }
} else {
  const { dir, rounds } = workerData;
  let round = 0;
  let last = "";
  const step = () => {
    if (round++ === rounds) {
      parentPort.postMessage(last);
      return;
    }
    readRound(dir, (line) => {
      last = line;
      setImmediate(step);
    });
  };
  step();
}
