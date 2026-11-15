// Error codes of Node's errors chapter that the core modules raise: an
// aborted operation's AbortError with code ABORT_ERR, a URLSearchParams
// built from pairs that are not pairs, a stream source that is not
// iterable, and the fs.cp errors for files that cannot be copied. Each
// case prints the class, name, code and message.
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const kind = (e) => (e instanceof TypeError ? "TypeError" : e instanceof RangeError ? "RangeError" : e instanceof Error ? "Error" : typeof e);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "compat-errors-"));
const show = (label, e) => console.log(label, [kind(e), e.name, e.code, String(e.message).replaceAll(directory, "<dir>")].join(" | "));
function shape(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    show(label, e);
  }
}
async function settles(label, promise) {
  try {
    await promise;
    console.log(label, "no rejection");
  } catch (e) {
    show(label, e);
  }
}

// An aborted operation.
const controller = new AbortController();
controller.abort();
await settles("timer", sleep(10, null, { signal: controller.signal }));
await settles("once", once(new EventEmitter(), "never", { signal: controller.signal }));
shape("throwIfAborted", () => controller.signal.throwIfAborted());

// Query pairs and iterables.
shape("pair of one", () => new URLSearchParams([["a"]]));
shape("pair of three", () => new URLSearchParams([["a", "b", "c"]]));
shape("not iterable", () => ReadableStream.from(5));

// fs.cp refuses a FIFO, a socket and a symlink that would be overwritten
// by its own subdirectory, synchronously and through the promise.
const at = (name) => path.join(directory, name);
execFileSync("mkfifo", [at("fifo")]);
shape("cpSync fifo", () => fs.cpSync(at("fifo"), at("fifo-copy")));
await settles("cp fifo", fs.promises.cp(at("fifo"), at("fifo-copy-2")));
fs.mkdirSync(at("source/a/b"), { recursive: true });
fs.symlinkSync(at("source/a/b"), at("source/link"));
fs.mkdirSync(at("target"));
fs.symlinkSync(at("source/a"), at("target/link"));
shape("cpSync symlink", () => fs.cpSync(at("source"), at("target"), { recursive: true }));
await settles("cp symlink", fs.promises.cp(at("source"), at("target"), { recursive: true }));
fs.mkdirSync(at("linked"));
fs.symlinkSync(at("source"), at("linked/link"));
fs.mkdirSync(at("inside"));
fs.symlinkSync(at("source/a"), at("inside/link"));
shape("cpSync symlink into itself", () => fs.cpSync(at("linked"), at("inside"), { recursive: true }));
shape("cpSync directory", () => fs.cpSync(at("source"), at("plain")));
fs.writeFileSync(at("file"), "x");
shape("cpSync onto directory", () => fs.cpSync(at("file"), at("target"), { recursive: true }));
shape("cpSync into itself", () => fs.cpSync(at("source"), at("source/a/copy"), { recursive: true }));
await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(at("socket"), async () => {
    shape("cpSync socket", () => fs.cpSync(at("socket"), at("socket-copy")));
    await settles("cp socket", fs.promises.cp(at("socket"), at("socket-copy-2")));
    server.close(resolve);
  });
});
fs.rmSync(directory, { recursive: true });
