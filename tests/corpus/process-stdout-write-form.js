// process.stdout.write(text) in its own call form: the boolean answers
// true for a synchronous write, a replaced write receives the string as
// its only argument with the stream as `this` and its boolean result comes
// back, a replacement that restores the original during its own call keeps
// the captured binding it goes on to use, a replacement that throws
// propagates from the call, both streams answer for their own descriptor,
// a lone surrogate reaches the stream as U+FFFD, and a closed descriptor
// answers false and reports the error through the stream's 'error' event.
import { closeSync } from "node:fs";

const out = [];
const first = process.stdout.write("first\n");
out.push(`stdout ${typeof first} ${first}`);
let seen = null;
const original = process.stdout.write;
process.stdout.write = function (chunk) {
  seen = `${arguments.length} ${typeof chunk} ${String(chunk)} ${this === process.stdout}`;
  return true;
};
const replaced = process.stdout.write("second");
process.stdout.write = original;
out.push(`replaced ${typeof replaced} ${replaced} ${seen}`);
let restored = 0;
function installRestoringWrite() {
  let received = "";
  const saved = process.stdout.write;
  process.stdout.write = function (chunk) {
    process.stdout.write = saved;
    received += String(chunk);
    restored = received.length;
    return true;
  };
}
installRestoringWrite();
process.stdout.write("restored\n");
out.push(`restored ${restored}`);
const fromStderr = process.stderr.write("on stderr\n");
out.push(`stderr ${typeof fromStderr} ${fromStderr}`);
out.push(`empty ${process.stdout.write("")}`);
process.stdout.write("lone \ud800 surrogate\n");
process.stdout.write = function () {
  throw new Error("write failed");
};
try {
  process.stdout.write("thrown");
} catch (error) {
  out.push(`threw ${error.message}`);
}
process.stdout.write = 5;
try {
  process.stdout.write("number");
} catch (error) {
  out.push(`number ${error.message}`);
}
process.stdout.write = undefined;
try {
  process.stdout.write("undefined");
} catch (error) {
  out.push(`undefined ${error.message}`);
}
process.stdout.write = original;
process.stdout.write(out.join("\n") + "\n");

process.stdout.on("error", function (err) {
  process.stderr.write(`event ${err.code}\n`);
});
closeSync(1);
const closed = process.stdout.write("lost");
process.stderr.write(`closed ${typeof closed} ${closed}\n`);
