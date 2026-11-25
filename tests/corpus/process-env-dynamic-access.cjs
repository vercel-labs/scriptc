// process.env is Node's proxy: every stored value goes through ToString
// (numbers, booleans, null/undefined text, joined arrays, an object's own
// toString — and a throw from it propagates, leaving the previous value),
// while a symbol value throws "Cannot convert a Symbol value to a string".
// A symbol key is ignored: reads answer undefined and deletes answer true
// without converting. A number key and a key object convert through ToString
// on both the read and the write.
"use strict";
function report(label, run) {
  try {
    console.log(label, "->", run());
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}
const s = Symbol("key");
// @ts-expect-error -- a symbol property reads nothing from the env proxy
report("symbol read", () => String(process.env[s]));
// @ts-expect-error
report("symbol delete", () => delete process.env[s]);
// @ts-expect-error
report("symbol write", () => {
  process.env[s] = "x";
});
const dynamicKey = /** @type {any} */ (s);
report("dynamic symbol read", () => String(process.env[dynamicKey]));
report("dynamic symbol delete", () => delete process.env[dynamicKey]);
report("dynamic symbol write", () => {
  process.env[dynamicKey] = "x";
});

process.env.SCRIPTC_ENV_VALUES = 42;
report("number value", () => String(process.env.SCRIPTC_ENV_VALUES));
process.env.SCRIPTC_ENV_VALUES = true;
report("boolean value", () => String(process.env.SCRIPTC_ENV_VALUES));
process.env.SCRIPTC_ENV_VALUES = null;
report("null value", () => String(process.env.SCRIPTC_ENV_VALUES));
const undefinedValue = /** @type {any} */ (undefined);
process.env.SCRIPTC_ENV_VALUES = undefinedValue;
report("undefined value", () => String(process.env.SCRIPTC_ENV_VALUES));
process.env.SCRIPTC_ENV_VALUES = [1, [2, 3]];
report("array value", () => String(process.env.SCRIPTC_ENV_VALUES));
report("object value", () => {
  process.env.SCRIPTC_ENV_VALUES = { toString: () => "coerced" };
  return String(process.env.SCRIPTC_ENV_VALUES);
});
report("throwing value", () => {
  process.env.SCRIPTC_ENV_VALUES = {
    toString() {
      throw new Error("value failed");
    },
  };
  return "assigned";
});
report("kept after throw", () => String(process.env.SCRIPTC_ENV_VALUES));
const symbolValue = /** @type {any} */ (Symbol("v"));
report("symbol value", () => {
  process.env.SCRIPTC_ENV_VALUES = symbolValue;
});

const numberKey = 918273;
report("number key write", () => {
  process.env[numberKey] = "numeric";
});
report("number key read", () => String(process.env[numberKey]));
report("number key delete", () => delete process.env[numberKey]);
report("number key gone", () => String(process.env[numberKey]));

const objectKey = { toString: () => "SCRIPTC_ENV_OBJECT" };
report("object key write", () => {
  process.env[objectKey] = 7;
});
report("object key read", () => String(process.env[objectKey]));
delete process.env.SCRIPTC_ENV_VALUES;
delete process.env.SCRIPTC_ENV_OBJECT;
