// The Blob and File classes: how parts are combined, how `type` and File
// names are normalized, slice() clamping, the reader methods, prototype
// branding, and the subclass relationship between File and Blob.
import { Blob, Buffer, File } from "node:buffer";

function shape(fn: () => unknown): string {
  try {
    return "ok " + String(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

// Parts concatenate in order, and every source kind is copied.
const parts = new Blob(["ab", new Uint8Array([0x63]), new Blob(["de"]), new DataView(new ArrayBuffer(1))]);
console.log("parts", parts.size, await parts.text());
const empty = new Blob();
console.log("empty", empty.size, JSON.stringify(empty.type), await empty.text());

// `type` is lowercased and stripped of characters outside the printable
// ASCII range; an empty result is the empty string.
const typed = ["TEXT/Plain", "text/html;charset=UTF-8", " bogus ", "a\u0000b", "é"];
for (const type of typed) {
  const blob = new Blob(["x"], { type });
  console.log("type", JSON.stringify(type), JSON.stringify(blob.type));
}
console.log("type non-string", JSON.stringify(new Blob(["x"], { type: 7 as unknown as string }).type));

// slice() clamps its range like the Web IDL conversions do.
const sliced = new Blob(["abcdef"], { type: "Text/Plain" });
console.log("slice", sliced.slice().size, sliced.slice(2).size, sliced.slice(-2).size, sliced.slice(1, -1).size);
console.log("slice far", sliced.slice(-100, 100).size, sliced.slice(4, 2).size, sliced.slice(1.9).size);
console.log("slice content", await sliced.slice(1, 3).text(), JSON.stringify(sliced.slice(1, 2, "IMG/PNG").type));
console.log("slice keeps type", sliced.slice(1).type, sliced.slice(1, 2, "").type);

// The readers return the same bytes.
const bytes = new Blob([Buffer.from("hi")]);
console.log("bytes", Buffer.from(await bytes.arrayBuffer()).toString("hex"), Buffer.from(await bytes.bytes()).toString("hex"));
console.log("text", JSON.stringify(await bytes.text()));

// File adds a name and a modification time; lastModified defaults to now
// and a non-finite value becomes zero.
const file = new File(["data"], "note.txt", { type: "TEXT/PLAIN", lastModified: 1234 });
console.log("file", file.size, file.name, file.type, file.lastModified, await file.text());
console.log("file default", typeof new File([], "x").lastModified);
console.log("file non-finite", new File([], "x", { lastModified: NaN }).lastModified);
const named = new File([], "a/b.txt");
console.log("file name", JSON.stringify(named.name));

// Branding and the class relationship.
console.log("brands", parts instanceof Blob, file instanceof File, file instanceof Blob, empty instanceof File);
console.log("tags", Object.prototype.toString.call(parts), Object.prototype.toString.call(file));
