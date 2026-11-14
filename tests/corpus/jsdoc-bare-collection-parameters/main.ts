// JSDoc parameters typed with a bare `{Set}` or `{Map}` (every type
// argument `any`) receive collections of concrete element types from
// typed TypeScript. Node passes the caller's collection itself, so the
// callee's writes are visible to the caller afterwards.
import { Registry, bump, remember } from "./lib.js";

const seen = new Set<number>([1, 2, 3]);
console.log(remember(seen, 4), seen.size, seen.has(4));
console.log(remember(seen, 4), [...seen].join(","));

const counts = new Map<string, number>([["a", 1]]);
console.log(bump(counts, "a"), bump(counts, "b"), JSON.stringify([...counts]));

const ids = new Set<string>();
const names = new Map<string, string>();
const registry = new Registry();
console.log(registry.register(ids, names, "x", "first"));
console.log(registry.register(ids, names, "y", "second"), ids.size, names.get("y"));
