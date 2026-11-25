// fs.Dir and fs.Dirent: opendirSync and fs.promises.opendir answer a Dir that
// walks a directory one Dirent at a time. Every entry reports its name, the
// path it was listed from, and the seven type predicates (a regular file, a
// directory, a symlink, a FIFO and a unix socket are real entries here).
// readSync and the promise read walk to null; read(callback) and
// close(callback) answer in Node's turns; a closed Dir throws or rejects
// ERR_DIR_CLOSED, and a Dir with an asynchronous operation outstanding
// throws ERR_DIR_CONCURRENT_OPERATION for its synchronous members. close
// validates its callback before the closed check, disposal closes the handle
// and stays silent on a closed Dir, and for-await iterates and then closes.
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-dir-listing-"));
const sock = path.join(dir, "sock");
// A FIFO and a unix socket are POSIX entries; on Windows both sides of the
// differential see the same tree without them.
const posix = process.platform !== "win32";
const clean = (text: string): string => text.split(dir).join("<dir>");
const describe = (entry: fs.Dirent): string =>
  [
    entry.name,
    entry.parentPath === dir,
    entry.isFile(),
    entry.isDirectory(),
    entry.isSymbolicLink(),
    entry.isFIFO(),
    entry.isSocket(),
    entry.isBlockDevice(),
    entry.isCharacterDevice(),
  ].join("|");
const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "?";
const detail = (error: unknown): string =>
  `${(error as Error).name} ${code(error)} ${(error as Error).message}`;

fs.mkdirSync(path.join(dir, "sub"));
fs.writeFileSync(path.join(dir, "sub", "inner.txt"), "x");
fs.writeFileSync(path.join(dir, "file.txt"), "x");
fs.symlinkSync("file.txt", path.join(dir, "link"));
if (posix) execFileSync("mkfifo", [path.join(dir, "fifo")]);

const server = posix ? net.createServer() : null;

async function syncWalk(): Promise<void> {
  const handle = fs.opendirSync(dir);
  console.log("path", clean(handle.path) === "<dir>", handle.path === dir);
  const rows: string[] = [];
  for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
    rows.push(describe(entry));
  }
  rows.sort();
  for (const row of rows) console.log("entry", row);
  console.log("end", handle.readSync() === null, handle.readSync() === null);
  handle.closeSync();
  try {
    handle.readSync();
  } catch (error) {
    console.log("readSync closed", (error as Error).name, code(error), (error as Error).message);
  }
  try {
    handle.closeSync();
  } catch (error) {
    console.log("closeSync closed", code(error));
  }
  // A closed Dir answers close(callback) on a next tick, and validates its
  // callback before it looks at the closed flag.
  await new Promise<void>((resolve) => {
    handle.close((error) => {
      console.log("close closed cb", (error as Error).name, code(error));
      resolve();
    });
  });
  try {
    handle.close(1 as unknown as () => void);
  } catch (error) {
    console.log("close bad cb", (error as Error).name, code(error), (error as Error).message);
  }
}

async function promiseWalk(): Promise<void> {
  const handle = await fs.promises.opendir(dir, { bufferSize: 2 });
  console.log("promise path", handle.path === dir);
  const first = await handle.read();
  const second = await handle.read();
  console.log("promise reads", first !== null, second !== null, typeof first?.name);
  const closedValue: unknown = await handle.close();
  console.log("promise close value", closedValue);
  try {
    await handle.read();
  } catch (error) {
    console.log("promise read closed", (error as Error).name, code(error));
  }
  try {
    await handle.close();
  } catch (error) {
    console.log("promise close closed", (error as Error).name, code(error));
  }
  try {
    handle.read(1 as unknown as () => void);
  } catch (error) {
    console.log("read bad cb closed", code(error));
  }
}

function callbackWalk(): Promise<void> {
  return new Promise<void>((resolve) => {
    const order: string[] = [];
    fs.opendir(dir, (openError, handle) => {
      console.log("opendir callback", openError === null, handle !== undefined && handle.path === dir);
      if (!handle) {
        resolve();
        return;
      }
      handle.read((readError, entry) => {
        order.push(`read:${readError === null}:${entry !== null}`);
        handle.read((secondError, second) => {
          order.push(`read:${secondError === null}:${second !== null}`);
          handle.close((closeError) => {
            order.push(`close:${closeError === null}`);
            handle.close((againError) => {
              order.push(`close:${againError?.code}`);
              console.log("callback order", order.join(" "));
              resolve();
            });
          });
        });
      });
    });
  });
}

async function concurrency(): Promise<void> {
  const handle = fs.opendirSync(dir);
  const pending = handle.read();
  try {
    handle.readSync();
  } catch (error) {
    console.log("readSync in flight", detail(error));
  }
  try {
    handle.closeSync();
  } catch (error) {
    console.log("closeSync in flight", detail(error));
  }
  let disposed: string;
  try {
    handle[Symbol.dispose]();
    disposed = "returned";
  } catch (error) {
    disposed = detail(error);
  }
  console.log("dispose in flight", disposed);
  console.log("the read still settles", (await pending) !== null);
  await handle[Symbol.asyncDispose]();
  console.log("async dispose closed it", (() => {
    try {
      handle.readSync();
      return "no throw";
    } catch (error) {
      return code(error);
    }
  })());

  const waiting = fs.opendirSync(path.join(dir, "sub"));
  const live = waiting.read();
  const closed = new Promise<string>((resolve) => {
    waiting.close((error) => resolve(error === null ? "null" : code(error)));
  });
  console.log("close waits for the read", (await live) !== null, await closed);

  const two = fs.opendirSync(path.join(dir, "sub"));
  const a = two.read();
  const b = two.read();
  const c = two.read();
  const settled = await Promise.all([a, b, c]);
  console.log(
    "queued reads",
    settled.map((entry) => (entry === null ? "null" : "entry")).join(" "),
  );
  await two.close();

  const again = fs.opendirSync(dir);
  again.closeSync();
  again[Symbol.dispose]();
  console.log("dispose closed", "returned");
  await again[Symbol.asyncDispose]();
  console.log("async dispose closed", "returned");
}

async function iteration(): Promise<void> {
  const sync = fs.opendirSync(path.join(dir, "sub"));
  const names: string[] = [];
  for await (const entry of sync) names.push(entry.name);
  console.log("for await sync", names.sort().join());
  try {
    sync.readSync();
  } catch (error) {
    console.log("for await closed sync", code(error));
  }
  const async = await fs.promises.opendir(path.join(dir, "sub"));
  const asyncNames: string[] = [];
  for await (const entry of async) asyncNames.push(entry.name);
  console.log("for await async", asyncNames.sort().join());
  const mixed = fs.opendirSync(path.join(dir, "sub"));
  console.log("pulled first", mixed.readSync() !== null);
  const rest: string[] = [];
  for await (const entry of mixed) rest.push(entry.name);
  console.log("for await rest", rest.length);
}

async function main(): Promise<void> {
  if (server) await new Promise<void>((resolve) => server.listen(sock, resolve));
  try {
    await syncWalk();
    await promiseWalk();
    await callbackWalk();
    await concurrency();
    await iteration();
  } finally {
    if (server) {
      server.close();
      await new Promise<void>((resolve) => server.once("close", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("removed", fs.existsSync(dir));
  }
}

main();
