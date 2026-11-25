// The `signal` of an fs stream in a JavaScript source, where the options
// are untyped values: the same events as in TypeScript, and Node's errors
// for a signal that is not an AbortSignal.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-ssu-"));
const file = path.join(dir, "data.txt");
fs.writeFileSync(file, "abcdefghij".repeat(500));

function shape(error) {
  const cause =
    error.cause === undefined
      ? "no cause"
      : error.cause instanceof Error
        ? `cause ${error.cause.name}: ${error.cause.message}`
        : `cause ${String(error.cause)}`;
  return `${error.name} ${error.code} "${error.message}" ${cause}`;
}

function run(label, make, during, last) {
  return new Promise((resolve) => {
    const log = [];
    let stream;
    try {
      stream = make();
    } catch (error) {
      console.log(`${label}: threw ${shape(error)}`);
      resolve(undefined);
      return;
    }
    for (const name of ["open", "ready", "end", "finish", "close"]) {
      stream.on(name, () => {
        log.push(name);
        if (name === last) {
          console.log(`${label}: ${log.join(" | ")}`);
          resolve(undefined);
        }
      });
    }
    stream.on("error", (error) => log.push(`error ${shape(error)}`));
    during(stream);
  });
}

function options(extra) {
  return Object.assign({ highWaterMark: 1000 }, extra);
}

async function main() {
  const live = new AbortController();
  await run("read, live", () => fs.createReadStream(file, options({ signal: live.signal })), (s) => s.resume(), "close");

  const reading = new AbortController();
  let chunks = 0;
  await run(
    "read, aborted while reading",
    () => fs.createReadStream(file, options({ signal: reading.signal })),
    (s) => s.on("data", () => { if (++chunks === 2) reading.abort(new Error("stop")); }),
    "close",
  );
  console.log("chunks", chunks);

  await run("read, already aborted", () => fs.createReadStream(file, options({ signal: AbortSignal.abort() })), (s) => s.on("open", (fd) => fs.closeSync(fd)), "ready");
  await run("new ReadStream, already aborted", () => new fs.ReadStream(file, options({ signal: AbortSignal.abort("why") })), (s) => s.on("open", (fd) => fs.closeSync(fd)), "ready");

  const writing = new AbortController();
  const out = path.join(dir, "out.txt");
  await run(
    "write, aborted after a write",
    () => fs.createWriteStream(out, options({ signal: writing.signal })),
    (s) => {
      s.write("kept");
      s.on("ready", () => setImmediate(() => writing.abort()));
    },
    "close",
  );
  console.log("file", fs.readFileSync(out, "utf8"));

  for (const signal of [null, 7, "s", {}, undefined]) {
    await run(`read, signal ${JSON.stringify(signal)}`, () => fs.createReadStream(file, options({ signal })), (s) => s.resume(), "close");
  }
  for (const signal of [null, true]) {
    await run(`write, signal ${JSON.stringify(signal)}`, () => fs.createWriteStream(out, options({ signal })), (s) => s.end(), "close");
  }
}

main();
