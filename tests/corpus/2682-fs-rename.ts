// The three static rename spellings: synchronous throws, promises reject,
// and the error-first callback runs asynchronously with Error | null.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rename,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename as renamePromise } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rename-"));
const a = join(dir, "a.txt");
const b = join(dir, "b.txt");
const c = join(dir, "c.txt");
const d = join(dir, "d.txt");
const missing = join(dir, "missing.txt");
const other = join(dir, "other.txt");
const workerSource = join(dir, "worker-source.txt");
const workerDest = join(dir, "worker-dest.txt");
const checkpointSourceA = join(dir, "checkpoint-a.txt");
const checkpointDestA = join(dir, "checkpoint-a-dest.txt");
const checkpointSourceB = join(dir, "checkpoint-b.txt");
const checkpointDestB = join(dir, "checkpoint-b-dest.txt");

writeFileSync(a, "alpha");
writeFileSync(b, "stale sync destination");
renameSync(a, b);
console.log("sync:", !existsSync(a), readFileSync(b, "utf8"));

const left = join(dir, "left");
const right = join(dir, "right");
const oldNested = join(left, "nested");
const newNested = join(right, "nested");
mkdirSync(left);
mkdirSync(right);
mkdirSync(oldNested);
renameSync(oldNested, newNested);
console.log("directory move:", !existsSync(oldNested), existsSync(newNested));
try {
  renameSync(missing, other);
} catch (e) {
  if (e instanceof Error) {
    const err = e as NodeJS.ErrnoException;
    console.log(
      "sync error:",
      err.code,
      err.message.includes("rename"),
      err.message.includes("missing.txt' -> '"),
      err.message.endsWith("other.txt'"),
    );
  }
}

async function run(): Promise<void> {
  writeFileSync(c, "stale promise destination");
  await renamePromise(b, c);
  console.log("promise:", !existsSync(b), readFileSync(c, "utf8"));
  try {
    await renamePromise(missing, other);
  } catch (e) {
    if (e instanceof Error) {
      console.log("promise error:", (e as NodeJS.ErrnoException).code, e.message.includes("rename"));
    }
  }

  // The OS request starts before callback delivery: blocking the JS/runtime
  // thread does not prevent libuv/the native worker from moving the file.
  // The stored callback intentionally returns boolean; TypeScript permits
  // that in a void callback slot and Node discards the value.
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  let renameReturned = false;
  writeFileSync(d, "stale callback destination");
  writeFileSync(workerSource, "worker");
  const onWorkerRename = (workerErr: NodeJS.ErrnoException | null): boolean => {
    console.log(
      "worker callback:",
      renameReturned,
      workerErr === null,
      !existsSync(workerSource),
      readFileSync(workerDest, "utf8"),
    );
    rename(c, d, (err) => {
      console.log("callback:", renameReturned, err === null, !existsSync(c), readFileSync(d, "utf8"));
      rename(missing, other, (missingErr) => {
        console.log(
          "callback error:",
          missingErr?.code,
          missingErr?.message.includes("rename"),
          missingErr?.message.includes("missing.txt' -> '"),
        );

        // Native callback boundaries are event-loop checkpoints: when two
        // operations are already complete, Node drains the first callback's
        // nextTicks and microtasks before invoking the second callback.
        let checkpointCallbacks = 0;
        let checkpointTicks = 0;
        let checkpointMicrotasks = 0;
        const onCheckpointRename = (): void => {
          checkpointCallbacks++;
          if (checkpointCallbacks === 2) {
            console.log(
              "callback checkpoints:",
              checkpointTicks === 1,
              checkpointMicrotasks === 1,
            );
            rmSync(dir, { recursive: true, force: true });
          }
          process.nextTick(() => {
            checkpointTicks++;
          });
          queueMicrotask(() => {
            checkpointMicrotasks++;
          });
        };
        writeFileSync(checkpointSourceA, "a");
        writeFileSync(checkpointSourceB, "b");
        rename(checkpointSourceA, checkpointDestA, onCheckpointRename);
        rename(checkpointSourceB, checkpointDestB, onCheckpointRename);
        while (existsSync(checkpointSourceA) || existsSync(checkpointSourceB)) {
          Atomics.wait(waitBuffer, 0, 0, 10);
        }
        // Both syscalls have returned; leave the workers time to publish
        // their completions before this callback gives the loop back control.
        Atomics.wait(waitBuffer, 0, 0, 50);
      });
    });
    return workerErr === null;
  };
  rename(workerSource, workerDest, onWorkerRename);
  renameReturned = true;
  let waits = 0;
  while (existsSync(workerSource) && waits < 100) {
    Atomics.wait(waitBuffer, 0, 0, 10);
    waits++;
  }
  console.log("worker progress:", !existsSync(workerSource), existsSync(workerDest));
}

void run();
