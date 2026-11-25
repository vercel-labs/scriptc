// process.chdir validates its path with Node's validateString before the
// chdir(2) call: a number, boolean, symbol, null, undefined, object or
// array throws the ERR_INVALID_ARG_TYPE "directory" message without any
// conversion (an object's toString never runs), and the working directory
// is left alone. The failure text's cwd is compared through a placeholder.
"use strict";
const anyValue = /** @type {(value: any) => any} */ ((value) => value);
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    const cwd = process.cwd();
    console.log(label, error.name, error.code, error.message.replaceAll(cwd, "<cwd>"));
  }
}
report("number", () => process.chdir(anyValue(1)));
report("null", () => process.chdir(anyValue(null)));
report("undefined", () => process.chdir(anyValue(undefined)));
report("object", () => process.chdir(anyValue({})));
report("object toString", () => {
  process.chdir(anyValue({ toString: () => "/nonexistent/scriptc-target" }));
});
report("array", () => process.chdir(anyValue(["/nonexistent/scriptc-array"])));
report("boolean", () => process.chdir(anyValue(true)));
report("symbol", () => process.chdir(anyValue(Symbol("d"))));
report("kept", () => process.cwd().length > 0);
