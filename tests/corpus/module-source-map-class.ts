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
