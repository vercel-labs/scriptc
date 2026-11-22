// The stored import.meta object in JavaScript: Node's own members, identity,
// added properties, and the object a child module exports for itself.
import { meta as child } from "./child.mjs";

const meta = import.meta;
meta.extra = 1;
meta.extra += 1;
console.log("extra", meta.extra, Object.keys(meta).length);
const { url, filename, main } = meta;
console.log("destructure", url === meta.url, filename === meta.filename, main === meta.main);
console.log("index", meta["url"] === meta.url, meta?.resolve === meta.resolve);
console.log("child", child !== meta, child.main, Object.keys(child).join(","));
console.log("prototype", Object.getPrototypeOf(meta) === null, typeof meta.toString);
const original = meta.url;
meta.url = "https://example.test/x";
const { url: mutated } = import.meta;
console.log("mutated", import.meta.url, meta.url, mutated);
meta.url = original;
const key = "filename";
console.log("runtime-key", import.meta[key] === import.meta.filename);
const resolve = meta.resolve;
console.log("resolve", typeof resolve, resolve.length, resolve.name);
console.log("json", JSON.stringify(meta).includes("\"extra\":2"), JSON.stringify(meta).includes("resolve"));
