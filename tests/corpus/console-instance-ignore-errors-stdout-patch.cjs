// What a replaced process.stdout.write receives from a Console instance over
// process.stdout: with ignoreErrors (the default) the line and an error
// handler, and a throw from the write is discarded; with ignoreErrors false,
// as an option or the third constructor argument, only the line, and the
// throw propagates out of the console method.
const { Console } = require("node:console");
const original = process.stdout.write;
const seen = [];
let fail = false;
process.stdout.write = function (chunk, encodingOrCallback, callback) {
  seen.push(`${typeof chunk}:${JSON.stringify(String(chunk))}:${typeof encodingOrCallback}:${typeof callback}`);
  if (fail) throw new Error("write failed");
  if (typeof encodingOrCallback === "function") encodingOrCallback(null);
  return true;
};
const strict = new Console({ stdout: process.stdout, ignoreErrors: false });
const lenient = new Console({ stdout: process.stdout });
const positional = new Console(process.stdout, process.stderr, false);
strict.log("strict", 1);
lenient.log("lenient");
positional.info("positional");
fail = true;
try {
  strict.log("throws");
  seen.push("strict: no throw");
} catch (e) {
  seen.push(`strict threw ${e.message}`);
}
try {
  lenient.log("swallowed");
  seen.push("lenient: no throw");
} catch (e) {
  seen.push(`lenient threw ${e.message}`);
}
try {
  console.log("global");
  seen.push("global: no throw");
} catch (e) {
  seen.push(`global threw ${e.message}`);
}
fail = false;
process.stdout.write = original;
console.log(seen.join("\n"));
