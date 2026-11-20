// module.SourceMap in JavaScript: the payload copy (fresh and shallow, with
// sliced arrays), the sections form, the constructor's payload validation,
// the options argument, instanceof, and what Object, JSON and inspect see.
// The payloads are parsed documents, the way a tool reads a .map file.
import * as nodeModule from "node:module";
import util from "node:util";

const { SourceMap } = nodeModule;
const payload = JSON.parse(
  '{"version":3,"file":"out.js","sourceRoot":"","sources":["a.ts"],' +
    '"sourcesContent":["x"],"names":["n"],"mappings":"AAAA"}',
);
const map = new SourceMap(payload);
console.log(
  "copy",
  map.payload !== payload,
  map.payload.sources !== payload.sources,
  map.payload.sourcesContent !== payload.sourcesContent,
  map.payload !== map.payload,
);
payload.sources.push("later.ts");
payload.mappings = "AAAA;AACA";
console.log("isolated", map.payload.sources.join(","), map.payload.mappings);
console.log("fields", Object.keys(map.payload).join(","));
console.log("shape", Object.keys(map).length, JSON.stringify(map), util.inspect(map));
console.log(
  "methods",
  typeof map.findEntry,
  map.findEntry.length,
  map.findEntry === map.findEntry,
  map.findOrigin.length,
);
const detached = map.findEntry;
try {
  detached(0, 0);
  console.log("detached ok");
} catch (error) {
  console.log("detached throws", error instanceof TypeError);
}

const sections = new SourceMap(
  JSON.parse(
    '{"version":3,"sources":[],"names":[],"mappings":"","sections":[' +
      '{"offset":{"line":0,"column":0},"map":{"version":3,"sources":["s.ts"],"names":["n"],"mappings":"AAAAA"}},' +
      '{"offset":{"line":2,"column":5},"map":{"version":3,"sources":["t.ts"],"names":[],"mappings":"AACA"}}]}',
  ),
);
for (const [line, column] of [
  [0, 0],
  [0, 1],
  [2, 5],
  [4, 0],
]) {
  const entry = sections.findEntry(line, column);
  console.log(
    "section",
    line,
    column,
    entry.generatedLine,
    entry.generatedColumn,
    entry.originalSource,
    entry.originalLine,
    entry.originalColumn,
    entry.name,
  );
}
console.log("empty", JSON.stringify(sections.findEntry(-1, 0)));
const origin = sections.findOrigin(3, 6);
console.log("origin", origin.name, origin.fileName, origin.lineNumber, origin.columnNumber);

const show = (label, call) => {
  try {
    call();
    console.log(label, "ok");
  } catch (error) {
    console.log(
      label,
      "throws",
      error.name,
      error.code,
      JSON.stringify(error.message),
      error instanceof TypeError,
    );
  }
};
show("no payload", () => new SourceMap());
show("undefined", () => new SourceMap(undefined));
show("null", () => new SourceMap(null));
show("array", () => new SourceMap([]));
show("string", () => new SourceMap("x"));
show("number", () => new SourceMap(1));
show("boolean", () => new SourceMap(true));
show("lineLengths array", () => new SourceMap(payload, { lineLengths: [1, 2] }));
show("lineLengths string", () => new SourceMap(payload, { lineLengths: "x" }));
show("extra argument", () => new SourceMap(payload, { lineLengths: [1] }, 3));
console.log("instanceof", map instanceof SourceMap, payload instanceof SourceMap, {} instanceof SourceMap);
