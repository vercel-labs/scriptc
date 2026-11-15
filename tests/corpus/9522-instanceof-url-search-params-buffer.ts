// `value instanceof URLSearchParams` and `value instanceof Buffer` where the
// value's static type does not say what it is: unknown, a union, another
// class, a record. The test answers by the class the value has at run time,
// and the branch it guards uses the value as that class.
import { Buffer as Bytes } from "node:buffer";
import { URLSearchParams as Params } from "node:url";

// A label for whatever a drawer holds.
function label(thing: unknown): string {
  if (thing instanceof URLSearchParams) return "query " + thing.toString();
  if (thing instanceof Buffer) return "bytes " + thing.toString("hex");
  if (thing instanceof Uint8Array) return "view " + thing.length;
  return typeof thing;
}
const drawer: unknown[] = [
  new URLSearchParams({ colour: "teal", size: "9" }),
  Buffer.from("ok"),
  new Uint8Array([1, 2, 3]),
  "colour=teal",
  7,
  null,
  undefined,
  { colour: "teal" },
  [1],
  new Map(),
  new URL("https://example.test/?colour=teal"),
];
console.log(drawer.map((thing) => label(thing)).join(" | "));

// URLSearchParams: every kind of operand.
function isQuery(value: unknown): boolean {
  return value instanceof URLSearchParams;
}
console.log(drawer.map((thing) => (isQuery(thing) ? "y" : "n")).join(""));
const query = new URLSearchParams("page=2");
const address = new URL("https://example.test/list?page=2");
console.log(
  query instanceof URLSearchParams,
  address.searchParams instanceof URLSearchParams,
  address instanceof URLSearchParams,
);
const record = { page: 2 };
const list = [1, 2];
console.log(record instanceof URLSearchParams, list instanceof URLSearchParams);
function pageOf(source: string | URLSearchParams): string {
  return source instanceof URLSearchParams ? (source.get("page") ?? "none") : source;
}
console.log(pageOf(new URLSearchParams("page=2")), pageOf("first"));
function count(value: unknown): string {
  if (!(value instanceof URLSearchParams)) return "no query";
  return "entries " + value.size;
}
console.log(count(new URLSearchParams("a=1&b=2")), count(new Map()));
// The class named through its module.
function isModuleQuery(value: unknown): boolean {
  return value instanceof Params;
}
console.log(isModuleQuery(new Params("a=1")), isModuleQuery(new URLSearchParams("a=1")), isModuleQuery("a=1"));

// Buffer: a byte view with a class of its own.
function isBuffer(value: unknown): boolean {
  return value instanceof Buffer;
}
const bytes = Buffer.from("abcd");
const view = new Uint8Array([1, 2]);
console.log(
  isBuffer(bytes),
  isBuffer(view),
  isBuffer("abcd"),
  isBuffer(bytes.subarray(1, 3)),
  isBuffer(new Uint8Array(bytes)),
  isBuffer(bytes.buffer),
);
console.log(bytes instanceof Buffer, view instanceof Buffer, bytes instanceof Uint8Array);
function width(value: string | Buffer): number {
  return value instanceof Buffer ? value.length : value.length * 2;
}
console.log(width(Buffer.from("abc")), width("abc"));
function isModuleBuffer(value: unknown): boolean {
  return value instanceof Bytes;
}
console.log(isModuleBuffer(Bytes.from("a")), isModuleBuffer(new Uint8Array(1)), isModuleBuffer("a"));
