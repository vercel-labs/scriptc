// node:module's SourceMap class in TypeScript: the constructor copies the
// payload the way Node does, findEntry answers the range at or before the
// point, and findOrigin adds the call site's offset back. Every answer is a
// differential assertion against Node.
import { SourceMap } from "node:module";
import type { SourceMapping, SourceOrigin } from "node:module";

const payload = {
  version: 3,
  file: "out.js",
  sourceRoot: "",
  sources: ["a.ts", "b.ts"],
  sourcesContent: ["let a = 1;", "let b = 2;"],
  names: ["a", "b"],
  mappings: "AAAA,SAASA;AACAA",
};
const map = new SourceMap(payload);
const copy = map.payload;
console.log(
  "copy",
  copy === payload,
  copy.sources === payload.sources,
  copy.sourcesContent === payload.sourcesContent,
);
console.log(
  "fields",
  copy.version,
  copy.file,
  copy.sourceRoot,
  copy.sources.join(","),
  copy.names.join(","),
  copy.mappings,
  copy.sourcesContent.join("|"),
);
const first = map.findEntry(0, 0) as SourceMapping;
console.log(
  "entry0",
  first.generatedLine,
  first.generatedColumn,
  first.originalSource,
  first.originalLine,
  first.originalColumn,
);
const second = map.findEntry(0, 9) as SourceMapping;
console.log(
  "entry1",
  second.generatedLine,
  second.generatedColumn,
  second.originalSource,
  second.originalLine,
  second.originalColumn,
);
const after = map.findEntry(5, 5) as SourceMapping;
console.log(
  "after",
  after.generatedLine,
  after.generatedColumn,
  after.originalSource,
  after.originalLine,
  after.originalColumn,
);
const origin = map.findOrigin(1, 1) as SourceOrigin;
console.log("origin", origin.fileName, origin.lineNumber, origin.columnNumber, origin.name);
const deep = map.findOrigin(9, 9) as SourceOrigin;
console.log("deep", deep.fileName, deep.lineNumber, deep.columnNumber, deep.name);
console.log("instance", map instanceof SourceMap, new SourceMap(payload) instanceof SourceMap);

// A VLQ field may carry more continuation digits than a 32-bit value has
// bits: Node's decoder shifts by the digit index modulo 32 and keeps the low
// 32 bits, so the same segment decodes to a wrapped, defined value instead of
// reading a shift past the width. The mappings text is outside input.
const longVlq = new SourceMap({
  version: 3,
  file: "out.js",
  sourceRoot: "",
  sources: ["a.ts"],
  sourcesContent: ["let a = 1;"],
  names: [],
  mappings: "h".repeat(13) + "C",
});
const longEntry = longVlq.findEntry(0, 0) as SourceMapping;
console.log(
  "long vlq",
  longEntry.generatedLine,
  longEntry.generatedColumn,
  longEntry.originalSource,
  longEntry.originalLine,
  longEntry.originalColumn,
);
const longOrigin = longVlq.findOrigin(0, 0) as Partial<SourceOrigin>;
console.log("long origin", JSON.stringify(longOrigin));
