import { expect, test } from "vitest";
import { AstDecodeError } from "./ast-bytes.js";
import { AstWireFile, parseAstNodeHandle } from "./ast-wire.js";
import {
  AstKind,
  HEADER_SIZE,
  KIND_NODE_LIST,
  NODE_LEN,
  PROTOCOL_VERSION,
} from "./ast-schema.generated.js";

function word(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
}

/** A small response with overlapping string slices, extended source-file
 * data, an empty structured array, and one list with two identifier nodes. */
function response(): Uint8Array {
  const bytes = new Uint8Array(44 + 16 + 8 + 48 + 4 + NODE_LEN * 5);
  word(bytes, 0, PROTOCOL_VERSION * 0x1000000);
  word(bytes, 24, 44);
  word(bytes, 28, 60);
  word(bytes, 32, 68);
  word(bytes, 36, 116);
  word(bytes, 40, 120);
  word(bytes, 44, 0);
  word(bytes, 48, 8);
  word(bytes, 52, 3);
  word(bytes, 56, 7);
  bytes.set(Buffer.from("abcfile!"), 60);
  word(bytes, 72, 2);
  word(bytes, 76, 2);
  for (const offset of [88, 92, 96, 100, 104, 108]) word(bytes, offset, 0xffffffff);
  bytes[116] = 0x90;
  const node = (index: number, kind: number, parent: number, next: number, data: number): void => {
    const at = 120 + index * NODE_LEN;
    word(bytes, at, kind);
    word(bytes, at + 12, next);
    word(bytes, at + 16, parent);
    word(bytes, at + 20, data);
  };
  node(1, AstKind.SourceFile, 0, 0, 0x80000000);
  node(2, KIND_NODE_LIST, 1, 0, 2);
  node(3, AstKind.Identifier, 2, 4, 0x40000002);
  node(4, AstKind.Identifier, 2, 0, 0x40000002);
  return bytes;
}

test("overlapping string slices and list parents preserve wire identities", () => {
  const file = new AstWireFile(response());
  expect(file.stringCount).toBe(2);
  expect(file.text(1)).toBe("abcfile!");
  expect(file.text(3)).toBe("file");
  expect(file.text(4)).toBe("file");
  expect(file.list(2)).toEqual([3, 4]);
  expect(file.semanticParent(3)).toBe(1);
  expect(file.namedChild(1, "statements")).toBe(2);
  expect(file.childAtOrder(1, 0)).toBe(2);
  for (const order of [-1, 0.5, 8, NaN, Infinity])
    expect(() => file.childAtOrder(1, order)).toThrow("invalid child slot");
  expect(file.namedChild(3, "name")).toBe(0);
  expect(file.fileReferences(0xffffffff)).toEqual([]);
  expect(file.fileReferences(0)).toEqual([]);
  expect(file.nodeIndices(0)).toEqual([]);
  expect(file.stringArray(0)).toEqual([]);
});

test("hash words remain unsigned and ordered", () => {
  const bytes = response();
  for (const [offset, value] of [
    [4, 0xffffffff],
    [8, 0x12345678],
    [12, 0x80000000],
    [16, 0xabcdef01],
  ])
    word(bytes, offset!, value!);
  word(bytes, 20, 0xffffffff);
  const file = new AstWireFile(bytes);
  expect(file.contentHash).toBe("abcdef018000000012345678ffffffff");
  expect(file.parseOptionsKey).toBe("4294967295");
});

test("node words respect a byte view's offset, signed spans and unsigned flags", () => {
  const original = response();
  const padded = new Uint8Array(original.length + 11).fill(0xff);
  padded.set(original, 3);
  const bytes = padded.subarray(3, 3 + original.length);
  const at = 120 + 3 * NODE_LEN;
  word(bytes, at + 4, 0xffffffff);
  word(bytes, at + 8, 0x80000000);
  word(bytes, at + 24, 0xfedcba98);
  const file = new AstWireFile(bytes);
  expect(file.kind(3)).toBe(AstKind.Identifier);
  expect(file.pos(3)).toBe(-1);
  expect(file.end(3)).toBe(-2147483648);
  expect(file.flags(3)).toBe(0xfedcba98);
  expect(file.data(3)).toBe(0x40000002);
  expect(file.next(3)).toBe(4);
  expect(file.parent(3)).toBe(2);
  expect(file.kind(4)).toBe(AstKind.Identifier);
  expect(() => file.kind(5)).toThrow(AstDecodeError);
});

test("strings, string offsets and node words read alike at every byte alignment", () => {
  const original = response();
  for (let shift = 0; shift < 4; shift++) {
    const padded = new Uint8Array(original.length + 8).fill(0xff);
    padded.set(original, shift);
    const bytes = padded.subarray(shift, shift + original.length);
    const file = new AstWireFile(bytes);
    expect([file.string(0), file.string(2), file.text(1), file.text(3)]).toEqual([
      "abcfile!",
      "file",
      "abcfile!",
      "file",
    ]);
    expect([file.kind(3), file.next(3), file.parent(4), file.data(4)]).toEqual([
      AstKind.Identifier,
      4,
      2,
      0x40000002,
    ]);
    word(bytes, 56, 9);
    expect(() => new AstWireFile(bytes)).toThrow("invalid string table offset");
  }
});

test("truncated headers, sections and node tables are rejected", () => {
  for (let size = 0; size < HEADER_SIZE; size++)
    expect(() => new AstWireFile(new Uint8Array(size))).toThrow(AstDecodeError);
  for (const [offset, value] of [
    [0, 0],
    [24, 40],
    [28, 59],
    [28, 67],
    [32, 59],
    [36, 69],
    [40, 119],
    [40, 0xffffffff],
    [48, 9],
    [52, 8],
    [56, 2],
  ]) {
    const bytes = response();
    word(bytes, offset!, value!);
    expect(() => new AstWireFile(bytes), `word ${offset} = ${value}`).toThrow(AstDecodeError);
  }
  expect(() => new AstWireFile(response().subarray(0, -1))).toThrow(AstDecodeError);
});

test("root-list and root-parent cycles cannot reach semantic walks", () => {
  for (const [offset, value] of [
    [120 + NODE_LEN, KIND_NODE_LIST],
    [120 + NODE_LEN + 16, 2],
  ]) {
    const bytes = response();
    word(bytes, offset!, value!);
    expect(() => new AstWireFile(bytes)).toThrow(AstDecodeError);
  }
});

test("invalid string, node, extended and structured offsets fail before access", () => {
  const file = new AstWireFile(response());
  for (const index of [-1, 0.5, NaN, Infinity, 5, 0xffffffff])
    expect(() => file.kind(index)).toThrow(AstDecodeError);
  for (const index of [-1, 0.5, 1, 3, 4, NaN])
    expect(() => file.string(index)).toThrow(AstDecodeError);
  for (const offset of [-4, 2, 48, NaN, Infinity])
    expect(() => file.extendedWord(1, offset)).toThrow(AstDecodeError);
  expect(() => file.extendedWord(3, 0)).toThrow("extended data");
  for (const offset of [-1, 0.5, 4, 0xffffffff, NaN])
    expect(() => file.structuredReader(offset)).toThrow(AstDecodeError);
});

test("malformed sibling links, list counts and parents cannot loop or escape", () => {
  for (const [offset, value, action] of [
    [120 + 3 * NODE_LEN + 12, 3, "list"],
    [120 + 3 * NODE_LEN + 12, 2, "list"],
    [120 + 3 * NODE_LEN + 12, 5, "list"],
    [120 + 4 * NODE_LEN + 16, 1, "list"],
    [120 + 2 * NODE_LEN + 20, 1, "list"],
    [120 + 2 * NODE_LEN + 20, 0xffffffff, "list"],
    [120 + 3 * NODE_LEN + 16, 3, "parent"],
    [120 + 3 * NODE_LEN + 16, 4, "parent"],
  ] as const) {
    const bytes = response();
    word(bytes, offset, value);
    const file = new AstWireFile(bytes);
    expect(
      () => (action === "list" ? file.list(2) : file.semanticParent(3)),
      `word ${offset} = ${value}`,
    ).toThrow(AstDecodeError);
  }
  const bytes = response();
  word(bytes, 120 + NODE_LEN + 20, 2); // presence bit for EOF, but no second child
  expect(() => new AstWireFile(bytes).namedChild(1, "statements")).not.toThrow();
  word(bytes, 120 + NODE_LEN + 20, 3); // both children present, missing EOF
  expect(() => new AstWireFile(bytes).namedChild(1, "endOfFileToken")).toThrow(
    "missing named child",
  );
});

test("structured references reject malformed tuples and invalid identities", () => {
  for (const data of [
    [0x91, 0x90],
    [0x91, 0],
    [0x91, 2],
    [0x91, 5],
    [0xdd, 0xff, 0xff, 0xff],
  ]) {
    const bytes = response();
    bytes.set(data.slice(0, 4), 116);
    const file = new AstWireFile(bytes);
    expect(() => file.fileReferences(0)).toThrow(AstDecodeError);
    expect(() => file.nodeIndices(0)).toThrow(AstDecodeError);
  }
});

test("node handles retain dotted and Windows paths while rejecting invalid numbers", () => {
  expect(parseAstNodeHandle("42.80.C:/src/a.b.ts")).toEqual({
    index: 42,
    kind: 80,
    path: "C:/src/a.b.ts",
  });
  for (const handle of [
    "",
    "1",
    "1.2",
    "1.2.",
    "0.2.path",
    "-1.2.path",
    "1.-2.path",
    "1e2.2.path",
    "4294967296.2.path",
    ".2.path",
    "1..path",
  ]) {
    expect(() => parseAstNodeHandle(handle), handle).toThrow(AstDecodeError);
  }
});
