// A createRequire loader is ONE function object in Node: every read of the
// binding — at any source position, through an import alias — is that value,
// and its `resolve` member is one function too. Different loaders stay
// distinct, and `resolve` is not `resolve.paths`.
import { createRequire } from "node:module";
import { req } from "./chunk.mjs";
import { req as req2 } from "./chunk.mjs";

const loader = createRequire(import.meta.url);
console.log("self:", loader === loader);
const saved = { fn: loader, resolve: loader.resolve };
console.log("stored:", saved.fn === loader);
console.log("resolve:", loader.resolve === loader.resolve, saved.resolve === loader.resolve);
console.log("paths:", loader.resolve.paths === loader.resolve.paths);
const other = createRequire(import.meta.url);
console.log("distinct:", loader === other, loader.resolve === other.resolve);
console.log("imported:", req === req, req === req2, req.resolve === req.resolve);
console.log("typeof:", typeof loader, typeof loader.resolve, typeof loader.resolve.paths);
console.log("resolve vs paths:", loader.resolve === loader.resolve.paths);
