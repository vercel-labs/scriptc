// A synchronous pipeline source function: Node calls it with { signal } and
// pumps what it returns — a readable stream answers an iterator, an iterable
// is iterated, and anything else is Node's invalid-return error naming the
// value. An untyped first stage that holds such a function takes the same
// path at run time.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const log = [];

/**
 * @param {string[]} into
 * @param {string} tag
 */
function sinkFor(into, tag) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(`${tag} ${typeof chunk} ${String(chunk)}`);
      cb();
    },
  });
}

{
  const out = [];
  await pipeline(function () {
    return Readable.from(["a", "b"]);
  }, sinkFor(out, "stream"));
  log.push(`source stream ${out.join(" | ")}`);
}

{
  const out = [];
  await pipeline(function () {
    return ["c", "d"];
  }, sinkFor(out, "array"));
  log.push(`source array ${out.join(" | ")}`);
}

{
  const out = [];
  await pipeline(function ({ signal }) {
    return signal ? Readable.from(["e"]) : Readable.from([]);
  }, sinkFor(out, "signal"));
  log.push(`source signal ${out.join(" | ")}`);
}

{
  const out = [];
  const untyped = (value) => value;
  await pipeline(
    untyped(function () {
      return Readable.from(["f"]);
    }),
    sinkFor(out, "untyped"),
  );
  log.push(`untyped source ${out.join(" | ")}`);
}

{
  const outcome = await pipeline(function () {
    return Promise.resolve(["g"]);
  }, sinkFor([], "promise")).then(
    () => "no error",
    (error) => `${error.code} ${error.message}`,
  );
  log.push(`source promise ${outcome}`);
}

{
  const outcome = await pipeline(function () {
    return new Writable({ write(_chunk, _enc, cb) { cb(); } });
  }, sinkFor([], "writable")).then(
    () => "no error",
    (error) => `${error.code} ${error.message}`,
  );
  log.push(`source writable ${outcome}`);
}

console.log(log.join("\n"));
