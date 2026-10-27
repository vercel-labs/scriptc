// Thrown values of every kind read back through catch bindings: primitives,
// arrays, plain objects, Errors and subclasses, undefined and null, through
// un-narrowed reads and through typeof, instanceof, Array.isArray and
// predicate narrowing.
class AppError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
interface Shaped {
  kind: string;
  size: number;
}
function isShaped(value: unknown): value is Shaped {
  return typeof value === "object" && value !== null && "kind" in value && "size" in value;
}
// Each value is thrown at its own static type (values thrown from `unknown`
// storage are covered separately).
const letters = ["a", "b", "c"];
const none: string[] = [];
const shapedValue: Shaped = { kind: "box", size: 3 };
const emptyObject = {};
const plainError = new Error("plain");
const typeError = new TypeError("typed");
const appError = new AppError("app", "E_APP");
const thrown: unknown[] = [
  5,
  0,
  -1.5,
  "text",
  "",
  true,
  false,
  letters,
  none,
  shapedValue,
  emptyObject,
  plainError,
  typeError,
  appError,
  undefined,
  null,
];
function throwAt(index: number): never {
  switch (index) {
    case 0:
      throw 5;
    case 1:
      throw 0;
    case 2:
      throw -1.5;
    case 3:
      throw "text";
    case 4:
      throw "";
    case 5:
      throw true;
    case 6:
      throw false;
    case 7:
      throw letters;
    case 8:
      throw none;
    case 9:
      throw shapedValue;
    case 10:
      throw emptyObject;
    case 11:
      throw plainError;
    case 12:
      throw typeError;
    case 13:
      throw appError;
    case 14:
      throw undefined;
    default:
      throw null;
  }
}
function describe(index: number): string {
  try {
    throwAt(index);
  } catch (e) {
    const parts: string[] = [String(e === thrown[index])];
    if (typeof e === "number") parts.push(`number ${e + 1}`);
    else if (typeof e === "string") parts.push(`string ${e.length}`);
    else if (typeof e === "boolean") parts.push(`boolean ${!e}`);
    else if (Array.isArray(e)) parts.push(`array ${e.length} ${e.join("+")}`);
    else if (e instanceof AppError) parts.push(`app ${e.code} ${e.message}`);
    else if (e instanceof Error) parts.push(`error ${e.name} ${e.message}`);
    else if (isShaped(e)) parts.push(`shaped ${e.kind} ${e.size}`);
    else if (e === undefined) parts.push("undefined");
    else if (e === null) parts.push("null");
    else parts.push(`other ${typeof e}`);
    return parts.join(" ");
  }
}
for (let i = 0; i < thrown.length; i++) console.log(i, describe(i));
for (let i = 0; i < 10; i++) {
  try {
    if (i === 5) throw i;
  } catch (e) {
    console.log("loop", e === 5, e);
  }
}
try {
  throw ["x", "y"];
} catch (e) {
  const list = e as string[];
  console.log(list[0], list[1], list.length);
}
