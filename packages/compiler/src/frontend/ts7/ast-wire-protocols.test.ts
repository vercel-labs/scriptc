import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { AstFile } from "./ast-node.js";
import { AstWireFile, PROTOCOL_VERSION_7_1 } from "./ast-wire.js";
import {
  AstKind,
  HEADER_OFFSET_NODES,
  KIND_NODE_LIST,
  NODE_LEN,
  NODE_OFFSET_DATA,
  NODE_OFFSET_KIND,
  PROTOCOL_VERSION,
} from "./ast-schema.generated.js";

/** The same sources' getSourceFile responses from tsc 7.0.2 (protocol 5)
 * and tsc 7.1.0-beta (protocol 9). */
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../test/fixtures/ts7-protocols.json", import.meta.url)),
    "utf8",
  ),
) as {
  sources: Record<string, string>;
  protocol5: Record<string, string>;
  protocol9: Record<string, string>;
};
const names = Object.keys(fixtures.sources);
const bytes = (protocol: "protocol5" | "protocol9", name: string): Uint8Array =>
  new Uint8Array(Buffer.from(fixtures[protocol][name]!, "base64"));

/** Every node's fields as TypeScript 7.0 sees them. A node list's flags word
 * is left out: protocol 9 stores whether the list has a trailing comma there,
 * which readers take from the source text. */
function nodes(wire: AstWireFile): string[] {
  const result: string[] = [];
  for (let index = 1; index < wire.nodeCount; index++) {
    const kind = wire.kind(index);
    const list = kind === KIND_NODE_LIST;
    result.push(
      [
        kind,
        wire.pos(index),
        wire.end(index),
        list ? 0 : wire.flags(index),
        list || wire.data(index) >>> 30 !== 2 ? wire.data(index) : wire.data(index) >>> 24,
        wire.parent(index),
        wire.next(index),
        list ? "" : (wire.text(index) ?? ""),
        list ? "" : (wire.rawText(index) ?? ""),
      ].join(" "),
    );
  }
  return result;
}

test("protocol 5 and protocol 9 responses decode to the same trees", () => {
  for (const name of names) {
    const old = new AstWireFile(bytes("protocol5", name));
    const next = new AstWireFile(bytes("protocol9", name));
    expect(old.protocol).toBe(PROTOCOL_VERSION);
    expect(next.protocol).toBe(PROTOCOL_VERSION_7_1);
    expect(nodes(next), name).toEqual(nodes(old));
    expect(next.preorder(), name).toEqual(old.preorder());
    const oldFile = new AstFile(bytes("protocol5", name)).sourceFile;
    const nextFile = new AstFile(bytes("protocol9", name)).sourceFile;
    expect(nextFile.fileName).toBe(oldFile.fileName);
    expect(nextFile.text).toBe(fixtures.sources[name]);
    expect(nextFile.languageVariant).toBe(oldFile.languageVariant);
    expect(nextFile.statements.nodes.length).toBe(oldFile.statements.nodes.length);
  }
});

test("protocol 9 node handles name TypeScript 7.1's kinds", () => {
  const file = new AstFile(bytes("protocol9", "main.ts"));
  const wire = file.wire;
  let index = 1;
  while (wire.kind(index) !== AstKind.FunctionDeclaration) index++;
  const node = file.node(index);
  expect(node.kind).toBe(AstKind.FunctionDeclaration);
  expect(node.id).toBe(`${index}.${AstKind.FunctionDeclaration + 1}.${file.root.path}`);
  expect(file.resolve(node.id)).toBe(node);
  expect(() => file.resolve(`${index}.${AstKind.FunctionDeclaration}.${file.root.path}`)).toThrow(
    "node handle kind does not match the response",
  );
  // Tokens below SourceKeyword keep their numbers.
  expect(wire.kindOnWire(AstKind.Identifier)).toBe(AstKind.Identifier);
  expect(wire.kindFromWire(167)).toBe(-1);
  const old = new AstFile(bytes("protocol5", "main.ts"));
  expect(old.node(index).id).toBe(`${index}.${AstKind.FunctionDeclaration}.${old.root.path}`);
});

/** A copy of `name`'s protocol 9 response with the first node of `kind`
 * (TypeScript 7.0's) changed by `change`. */
function changed(
  name: string,
  kind: number,
  change: (view: DataView, at: number) => void,
): Uint8Array {
  const data = bytes("protocol9", name);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nodes = view.getUint32(HEADER_OFFSET_NODES, true);
  const onWire = kind >= 167 ? kind + 1 : kind;
  for (let at = nodes + NODE_LEN; at < data.length; at += NODE_LEN) {
    if (view.getUint32(at + NODE_OFFSET_KIND, true) !== onWire) continue;
    change(view, at);
    return data;
  }
  throw new Error(`no node of kind ${kind}`);
}

test("protocol 9 nodes that TypeScript 7.0 has no form for are rejected", () => {
  const sourceKeyword = changed("main.ts", AstKind.Identifier, (view, at) =>
    view.setUint32(at + NODE_OFFSET_KIND, 167, true),
  );
  expect(() => new AstWireFile(sourceKeyword)).toThrow("SourceKeyword");
  const attributes = changed("main.ts", AstKind.ModuleDeclaration, (view, at) =>
    view.setUint32(at + NODE_OFFSET_DATA, view.getUint32(at + NODE_OFFSET_DATA, true) | 4, true),
  );
  expect(() => new AstWireFile(attributes)).toThrow("import attributes on a module declaration");
  const source = changed("main.ts", AstKind.ImportClause, (view, at) =>
    view.setUint32(
      at + NODE_OFFSET_DATA,
      (view.getUint32(at + NODE_OFFSET_DATA, true) | (3 << 24)) >>> 0,
      true,
    ),
  );
  expect(() => new AstWireFile(source)).toThrow("`import source`");
  const version = bytes("protocol9", "main.ts");
  version[3] = 6;
  expect(() => new AstWireFile(version)).toThrow("unsupported protocol version 6");
});
