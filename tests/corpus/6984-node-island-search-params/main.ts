// @requires-libnode
// A native URLSearchParams in a Node island is a URLSearchParams there, and
// the two are one list: a write on either side shows on the other. The
// searchParams of a native URL is, in the island, the searchParams object
// of that URL, whichever of the two the island is handed first.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function fresh(): URLSearchParams {
  return new URLSearchParams("b=2&a=1&b=3");
}

const list = fresh();
const other = fresh();
for (const line of lib.describe(list)) console.log(line);
console.log("keep", lib.keep(list), lib.keep(list), lib.keep(other), lib.keep(list));
const back: URLSearchParams = lib.back(list);
console.log("back", back === list, back === other, back.toString());

// The island writes, the program reads.
for (const [method, a, b] of [
  ["append", "c", "4 5"],
  ["set", "b", "9"],
  ["delete", "b", ""],
  ["sort", "", ""],
]) {
  const p = fresh();
  lib.write(p, method, a, b);
  console.log("island", method, p.toString(), p.getAll("b").join("+"), p.size, lib.text(p) === p.toString());
}

// The program writes, the island reads its object from before the write.
function native(label: string, write: (p: URLSearchParams) => void): void {
  const p = fresh();
  lib.hold(p);
  write(p);
  console.log("native", label, p.toString(), lib.heldText() === p.toString(), lib.text(p) === p.toString());
}
native("append", (p) => p.append("c", "4 5"));
native("set", (p) => p.set("b", "9"));
native("delete", (p) => p.delete("b"));
native("sort", (p) => p.sort());
native("values that need escaping", (p) => p.append("k&=", "v+é %"));
native("emptied", (p) => {
  p.delete("a");
  p.delete("b");
});

// A URL's searchParams, handed over before its URL.
const first = new URL("http://example.test/b?y=2");
console.log("params first", lib.keepParams(first.searchParams), lib.isParamsOf(first, first.searchParams));
// And after its URL.
const second = new URL("http://example.test/c?z=3");
console.log("url first", lib.href(second), lib.isParamsOf(second, second.searchParams));

// Writes through a URL's searchParams from the island reach the URL.
const written = new URL("http://example.test/d?z=3");
lib.write(written.searchParams, "append", "k", "v");
console.log("island wrote the params", written.href, lib.href(written));
// A native write to the URL reaches the island's params object.
const held = new URL("http://example.test/e?z=3");
const params = held.searchParams;
lib.hold(params);
held.search = "?n=1";
console.log("native wrote the url", lib.heldText(), params.toString());
params.append("m", "2");
console.log("native wrote the params", lib.heldText(), lib.href(held));
