// Builtins that convert a number argument with ToNumber see a missing
// read (an out-of-range typed-array or array read the checker types as
// `number`) as NaN, ToNumber's answer for undefined: String.fromCharCode
// yields code unit 0, fromCodePoint throws a RangeError, Math answers NaN,
// isNaN is true. The missing value reaches them from a module binding, a
// local, a class field and a record field.
const base: number = process.argv.length;
const chars = new Uint16Array(4);
chars[0] = 108;
chars[1] = 66;
const nums: number[] = [7];
const far = base + 100;

const missing = chars[far];
const present = chars[1];
const missingNum = nums[far];

function show(label: string, value: unknown): void {
  console.log(label, typeof value === "string" ? JSON.stringify(value) : value);
}

function attempt(label: string, run: () => unknown): void {
  try {
    show(label, run());
  } catch (e) {
    console.log(label, "threw", (e as Error).name, (e as Error).message);
  }
}

// String.fromCharCode / fromCodePoint.
show("fcc module", String.fromCharCode(chars[0], missing));
show("fcc single", String.fromCharCode(missing));
show("fcc present", String.fromCharCode(chars[0], present));
show("fcc array", String.fromCharCode(missingNum, 65));
attempt("fcp module", () => String.fromCodePoint(missing));
show("fcp present", String.fromCodePoint(present));

// Math functions.
show("abs", Math.abs(missing));
show("floor", Math.floor(missingNum));
show("max", Math.max(missing, 1));
show("min3", Math.min(1, 2, missing));
show("imul", Math.imul(missing, 3));
show("pow", Math.pow(present, 2));
show("hypot", Math.hypot(missing, 3));

// The global number predicates convert; the Number statics do not.
show("isNaN", isNaN(missing));
show("isNaN present", isNaN(present));
show("isFinite", isFinite(missing));
show("isFinite present", isFinite(present));
show("Number.isNaN", Number.isNaN(missing));
show("Number.isFinite", Number.isFinite(missing));

// DataView offsets (ToIndex) and values (ToNumber).
const view = new DataView(new ArrayBuffer(4));
view.setUint8(1, 9);
show("dv get", view.getUint8(missing));
view.setUint8(missing, 5);
show("dv set offset", view.getUint8(0));
view.setUint8(2, missing);
show("dv set value", view.getUint8(2));

// Typed-array ranges: a missing start is 0, a missing end is the length.
show("slice start", chars.slice(missing).length);
show("slice end", chars.slice(1, missing).length);
show("subarray start", chars.subarray(missing).length);
show("subarray end", chars.subarray(2, missing).length);

// The same reads held in a local, a class field and a record field.
function local(i: number, label: string): void {
  let code: number | undefined = 0;
  code = chars[i];
  show(`local fcc ${label}`, String.fromCharCode(97, code));
  show(`local max ${label}`, Math.max(code, 1));
  show(`local isNaN ${label}`, isNaN(code));
}
local(far, "missing");
local(1, "present");

class Cursor {
  code: number | undefined = 0;
}
const cursor = new Cursor();
cursor.code = chars[far];
show("field fcc", String.fromCharCode(97, cursor.code));
show("field abs", Math.abs(cursor.code));
cursor.code = chars[1];
show("field fcc present", String.fromCharCode(97, cursor.code));

const record: { code: number | undefined } = { code: 0 };
record.code = chars[far];
show("record fcc", String.fromCharCode(97, record.code));
show("record max", Math.max(record.code, 1));
show("record isNaN", isNaN(record.code));
