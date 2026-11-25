// process.umask validates its mask the way Node's parseFileMode and
// validateUint32 do: an octal string or a number sets the mask and answers
// the previous one, undefined reads without setting, and every other value
// throws — the type TypeError (null reads as the missing argument: Received
// undefined), the ERR_INVALID_ARG_VALUE for a string that is not octal, and
// the integer/range RangeErrors. The previous mask is compared against a
// mask this program set itself, so the answer does not depend on the
// environment's umask.
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
const original = process.umask(0o022);
report("octal string", () => process.umask("077") === 0o022);
report("read back", () => process.umask());
report("set back", () => process.umask("022") === 0o077);
report("null", () => process.umask(null));
report("undefined", () => process.umask(undefined) === 0o022);
report("string word", () => process.umask("wrong"));
report("float", () => process.umask(1.5));
report("negative", () => process.umask(-1));
report("too big", () => process.umask(2 ** 32));
report("bool", () => process.umask(true));
report("object", () => process.umask({}));
report("symbol", () => process.umask(Symbol("m")));
report("empty string", () => process.umask(""));
report("eight", () => process.umask("08"));
report("space", () => process.umask(" 77"));
process.umask(original);
console.log("restored", typeof process.umask());
