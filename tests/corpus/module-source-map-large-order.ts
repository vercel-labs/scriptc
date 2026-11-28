// A large reverse-ordered mapping: delta-coded segments may name decreasing
// columns, so the constructor must order them in near-linear time rather than
// quadratically. Every binary here is either already ordered (the common
// case) or sorted by a merge sort, so construction stays fast.
import { SourceMap } from "node:module";
import type { SourceMapping } from "node:module";

const segments = 200_000;
// One column-only segment per entry: column 0, then -1 for each later one.
const parts: string[] = ["A"];
for (let i = 1; i < segments; i++) parts.push("D");
const mappings = parts.join(",");

const started = performance.now();
const map = new SourceMap({
  version: 3,
  file: "",
  sources: [],
  sourcesContent: [],
  names: [],
  mappings,
  sourceRoot: "",
});
const elapsed = performance.now() - started;
console.log("fast", elapsed < 1000);

const first = map.findEntry(0, -(segments - 1)) as SourceMapping;
const middle = map.findEntry(0, -5) as SourceMapping;
const last = map.findEntry(0, 0) as SourceMapping;
console.log("first", first.generatedLine, first.generatedColumn);
console.log("middle", middle.generatedLine, middle.generatedColumn);
console.log("last", last.generatedLine, last.generatedColumn);
console.log("before", typeof map.findEntry(0, -segments));
