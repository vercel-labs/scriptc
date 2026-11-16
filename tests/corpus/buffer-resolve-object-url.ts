// buffer.resolveObjectURL: the Blob registered under an object URL's id,
// as a fresh Blob per call that shares the registration's bytes and type.
// Covers a single-part and a multi-part Blob, a File registration (which
// resolves as a Blob), an id carrying a query or fragment (the pathname
// names the registration), an unknown id, the empty string, a non-blob
// URL and a blob: URL with no nodedata path, and the state after
// URL.revokeObjectURL. Object URLs carry a random id, so the program never
// prints one — only sizes, types and the shape of the answer.
import { Blob, File, resolveObjectURL } from "node:buffer";

function describe(id: string): string {
  const resolved = resolveObjectURL(id);
  if (resolved === undefined) return "undefined";
  return `${resolved instanceof Blob} ${resolved.size} ${JSON.stringify(resolved.type)}`;
}

const blob = new Blob(["hello", " world"], { type: "text/plain" });
const id = URL.createObjectURL(blob);
console.log("single", describe(id));
const first = resolveObjectURL(id);
const second = resolveObjectURL(id);
console.log("fresh", first !== undefined, second !== undefined, first === second, first !== undefined && first.size);
if (first !== undefined) first.text().then((text) => console.log("text", JSON.stringify(text)));

const file = new File(["filedata"], "a.txt", { type: "Text/Plain" });
const fileId = URL.createObjectURL(file);
console.log("file", describe(fileId));

console.log("suffixes", describe(id + "?x=1"), describe(id + "#fragment"), describe(id + "?q#f"));
console.log("unknowns", describe("blob:nodedata:nope"), describe(""), describe("https://example.com/x"), describe("blob:https://example.com/abc"), describe("blob:nodedata:a:b"));

URL.revokeObjectURL(id);
console.log("revoked", describe(id), describe(fileId));
URL.revokeObjectURL(id);
console.log("revoke twice", describe(fileId));
