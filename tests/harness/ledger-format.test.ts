/* The internal compatibility ledger's on-disk encoding: rows are arrays
 * named once, and node stability notes and test paths are interned. The
 * object shape every consumer uses is what decodeLedger restores, and a
 * ledger in the older object-row form still decodes. */
import { expect, test } from "vitest";
import {
  decodeLedger,
  encodeLedger,
  parseLedger,
  serializeLedger,
} from "../../internal/compatibility/src/ledger-format.mjs";

const stability = { index: "2", level: 2, text: "Stable", inherited: false };

const rows = [
  {
    id: "assert:one",
    chapter: "assert",
    kind: "class",
    name: "assert.One",
    signature: "Class: `assert.One`",
    label: "assert.One",
    apiSymbol: "assert.One",
    depth: 1,
    scope: "api",
    anchor: "class-assertone",
    nodeStability: stability,
    static: { status: "partial", evidence: "compiler-feature:assert.One", tests: ["p", "q"] },
    anchorSource: "exact",
  },
  {
    id: "assert:two",
    chapter: "assert",
    kind: "method",
    name: "assert.One.two",
    signature: "`assert.One.prototype.two()`",
    label: "two",
    apiSymbol: "assert.One.two",
    depth: 2,
    scope: "api",
    anchor: "class-assertone-two",
    nodeStability: stability,
    static: { status: "supported", evidence: "compiler-feature:assert.One.two", tests: ["q"] },
    anchorSource: "exact",
  },
  {
    id: "assert:three",
    chapter: "assert",
    kind: "method",
    name: "assert.Three",
    signature: "`assert.Three()`",
    label: "Three",
    apiSymbol: "assert.Three",
    depth: 1,
    scope: "api",
    anchor: "",
    nodeStability: null,
    static: { status: "not-implemented", evidence: "compiler-dedicated:assert.Three" },
    anchorSource: "chapter",
  },
];

const snapshot = {
  schemaVersion: 5,
  nodeVersion: "24.0.0",
  nodeTag: "v24.0.0",
  nodeCommit: "0000",
  sources: { allJson: { url: "u", sha256: "s" } },
  supportManifests: { compilerSurface: "m" },
  chapters: [{ slug: "assert", title: "Assert", entries: 3, apiEntries: 3 }],
  rows,
  anchors: { verified: 2, ancestorFallback: 0, chapterFallback: 1 },
};

test("rows are arrays and repeated values are interned once", () => {
  const encoded = encodeLedger(snapshot);
  expect(encoded.testPaths).toEqual(["p", "q"]);
  expect(encoded.stabilities).toEqual([stability]);
  expect(encoded.rows.every(Array.isArray)).toBe(true);
  // The file stays one line with a trailing newline, small enough to push.
  const text = serializeLedger(snapshot);
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trimEnd().includes("\n")).toBe(false);
  expect(text.length).toBeLessThan(JSON.stringify(snapshot).length);
});

test("decoding restores the object shape every reader uses", () => {
  const text = serializeLedger(snapshot);
  expect(parseLedger(text)).toEqual(snapshot);
  // Re-encoding what decoding produced writes the same text.
  expect(serializeLedger(parseLedger(text))).toBe(text);
});

test("a ledger in the older object-row form still decodes", () => {
  expect(decodeLedger(snapshot)).toBe(snapshot);
});

test("a row field the encoding does not name is refused", () => {
  const grown = { ...snapshot, rows: [{ ...rows[0], extra: 1 }, rows[1], rows[2]] };
  expect(() => encodeLedger(grown)).toThrow(/update LEDGER_COLUMNS/);
});
