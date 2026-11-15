// @requires-libnode
// JavaScript that replaces a stream's write through an alias: the stream is
// a function argument, so no assignment names process.stdout. The island's
// output still reaches the replacement, because the program holds the
// stream as a value.
import { requireModule } from "@scriptc/node";

const { speak } = requireModule("./voice.cjs");

function capture(stream, lines) {
  const original = stream.write;
  stream.write = function (chunk, encoding, callback) {
    lines.push(`${typeof chunk === "string" ? chunk.trimEnd() : `<${chunk.length} bytes>`}`);
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done(null);
    return true;
  };
  return () => {
    stream.write = original;
  };
}

const out = [];
const err = [];
const releaseOut = capture(process.stdout, out);
const releaseErr = capture(process.stderr, err);
console.log("native line");
speak("captured");
releaseOut();
releaseErr();
speak("released");
console.log(JSON.stringify(out));
console.log(JSON.stringify(err));
