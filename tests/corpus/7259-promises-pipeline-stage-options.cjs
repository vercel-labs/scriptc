// stream/promises pipeline() with function stages or an iterable source
// and the options argument: end: false leaves the destination open, a
// signal aborts the pipeline (the stages see their own signal abort), an
// async function destination's value resolves the promise, and a value
// that is not an AbortSignal rejects with ERR_INVALID_ARG_TYPE.
const { PassThrough, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const log = [];

const upper = async function* (source) {
  for await (const chunk of source) yield String(chunk).toUpperCase();
};

function sink(name) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      log.push(`${name} got ${chunk}`);
      cb();
    },
  });
}

async function main() {
  const joined = await pipeline(["a", "b"], upper, async function (source) {
    let s = "";
    for await (const c of source) s += c;
    return s;
  }, { end: true });
  log.push(`joined ${joined}`);

  const open = new PassThrough({ objectMode: true });
  await pipeline(["k"], upper, open, { end: false });
  log.push(`end false: ended ${open.writableEnded}`);
  open.end("last");
  const rest = [];
  for await (const c of open) rest.push(c);
  log.push(`end false: read ${rest.join(",")}`);

  const ac = new AbortController();
  const slow = async function* (source, { signal }) {
    signal.addEventListener("abort", () => log.push(`stage signal aborted ${signal.aborted}`));
    for await (const chunk of source) {
      yield chunk;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  };
  const aborting = pipeline(["s1", "s2", "s3"], slow, sink("abort"), { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  try {
    await aborting;
  } catch (e) {
    log.push(`aborted ${e.name} ${e.code}`);
  }

  try {
    await pipeline(["v"], upper, sink("bad"), { signal: "nope" });
  } catch (e) {
    log.push(`bad signal ${e.code}`);
  }
  console.log(log.join("\n"));
}

main();
