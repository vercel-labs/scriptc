import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import ts5 from "typescript5";
import { Ts7Api } from "./rpc-api.js";
import type { Ts7FileSystem } from "./rpc-filesystem.js";
import { Ts7SourceParser, type Ts7SourceKind } from "./source-parser.js";
import { closeSourceParser, parseSourceFile } from "./source-parser-node.js";
import * as ts from "./syntax.js";
import { getTextOfNode, tokenStartOfNode } from "./node-functions.js";

const parsers: Ts7SourceParser[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const parser of parsers.splice(0)) parser.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  closeSourceParser();
});

function create() {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-source-parser-"),
  );
  directories.push(directory);
  let filesystem!: Ts7FileSystem;
  const parser = new Ts7SourceParser((options) => {
    filesystem = options.fs;
    return new Ts7Api(options);
  }, directory);
  parsers.push(parser);
  return { parser, directory, fs: filesystem };
}

test("each parse owns its text and nodes across same-path edits, deletion and close", () => {
  const { parser } = create();
  const first = parser.parse("input.ts", "export const first = 1;", "ts");
  expect(parser.parse("input.ts", first.text, "ts")).toBe(first);
  const second = parser.parse("input.ts", "export const second = 2;", "ts");
  expect(second.text).toBe("export const second = 2;");
  expect(second).not.toBe(first);
  const other = parser.parse("other.js", "exports.third = 3;", "js");
  const empty = parser.parse("input.ts", "", "ts");
  expect(empty.statements.nodes).toEqual([]);
  const restored = parser.parse("input.ts", first.text, "ts");
  expect(restored.text).toBe(first.text);
  parser.close();
  parser.close();
  expect(getTextOfNode(first.statements.nodes[0]!)).toBe("export const first = 1;");
  expect(second.statements.nodes[0]!.parent).toBe(second);
  expect(getTextOfNode(other.statements.nodes[0]!)).toBe("exports.third = 3;");
  expect(() => parser.parse("late.ts", "", "ts")).toThrow("closed");
});

test("the syntax filesystem hides project configuration, dependencies and libraries", () => {
  const { parser, directory, fs } = create();
  writeFileSync(
    join(directory, "tsconfig.json"),
    '{"extends":"./missing.json","compilerOptions":{"jsx":"react"}}',
  );
  writeFileSync(join(directory, "dependency.ts"), "export const fromDisk = 42;");
  const source = 'import { fromDisk } from "./dependency.js"; export const result = fromDisk;';
  const file = parser.parse("input.ts", source, "ts");
  expect(file.text).toBe(source);
  expect(fs.readFile(join(directory, "dependency.ts"))).toBeNull();
  expect(fs.readFile(join(directory, "tsconfig.json"))).toBeNull();
  expect(fs.fileExists(join(directory, "dependency.ts"))).toBe(false);
  expect(fs.directoryExists(join(directory, "node_modules"))).toBe(false);
  expect(fs.getAccessibleEntries(directory)).toEqual({ files: [], directories: [] });
  expect(fs.readFile(join(directory, "input.ts"))).toBe(source);
  parser.parse("next.ts", "export {};", "ts");
  expect(fs.readFile(join(directory, "input.ts"))).toBeNull();
  parser.close();
  expect(fs.fileExists(join(directory, "next.ts"))).toBe(false);
});

const syntaxCases: { name: string; kind: Ts7SourceKind; source: string }[] = [
  { name: "empty.ts", kind: "ts", source: "" },
  { name: "bom.ts", kind: "ts", source: "\ufeffexport const value = 1;\r\n" },
  {
    name: "comments.js",
    kind: "js",
    source: "#!/usr/bin/env node\n// leading\n/** detail */\nexport class A { value = 1; }\n",
  },
  { name: "unicode.ts", kind: "ts", source: 'const 工作 = "😀";\r\nexport { 工作 };\n' },
  {
    name: "types.d.mts",
    kind: "ts",
    source: "export declare class A { optional?: A | null; definite!: number; method?(): string; }",
  },
  { name: "broken.ts", kind: "ts", source: "export const incomplete = ;\nfunction broken( {\n" },
  {
    name: "component.tsx",
    kind: "tsx",
    source: 'export const element = <main title="x">Hello {value}<span /></main>;',
  },
  { name: "component.jsx", kind: "jsx", source: "export default <><span /> text</>;" },
];

for (const { name, kind, source } of syntaxCases) {
  test(`standalone syntax preserves TypeScript source spans: ${name}`, () => {
    const { parser } = create();
    const file = parser.parse(name, source, kind);
    const grammar =
      kind === "ts"
        ? ts5.ScriptKind.TS
        : kind === "js"
          ? ts5.ScriptKind.JS
          : kind === "tsx"
            ? ts5.ScriptKind.TSX
            : ts5.ScriptKind.JSX;
    const oracle = ts5.createSourceFile(name, source, ts5.ScriptTarget.Latest, true, grammar);
    expect(file.text).toBe(source);
    expect(file.isDeclarationFile).toBe(oracle.isDeclarationFile);
    expect(
      file.statements.nodes.map((statement) => ({
        start: tokenStartOfNode(statement),
        end: statement.end,
        text: getTextOfNode(statement),
      })),
    ).toEqual(
      oracle.statements.map((statement) => ({
        start: statement.getStart(),
        end: statement.end,
        text: statement.getText(),
      })),
    );
    for (let position = 0; position <= source.length; position++) {
      expect(file.getLineAndCharacterOfPosition(position)).toEqual(
        oracle.getLineAndCharacterOfPosition(position),
      );
    }
  });
}

test("explicit grammar keeps declaration suffixes and separates same-name inputs", () => {
  const { parser, directory } = create();
  const types = parser.parse("input.d.cts", "export declare class A {}", "ts");
  expect(types.isDeclarationFile).toBe(true);
  expect(types.fileName).toBe(resolve(directory, "input.d.cts").split("\\").join("/"));
  const source = "export class B {}";
  const js = parser.parse("input.d.cts", source, "js");
  expect(js.isDeclarationFile).toBe(false);
  expect(js.fileName).toMatch(/input\.d\.cts\.js$/);
  expect(parser.parse("input.d.cts", source, "ts").isDeclarationFile).toBe(true);
});

test("optional declarations expose question tokens without confusing definite assignment", () => {
  const { parser } = create();
  const file = parser.parse(
    "input.ts",
    "class A { optional?: number; definite!: number; method?(): void; } type M<T> = { [K in keyof T]-?: T[K] };",
    "ts",
  );
  const declaration = file.statements.nodes[0]!;
  if (!ts.isClassDeclaration(declaration)) throw new Error("expected class");
  expect(declaration.members.nodes[0]!.questionToken?.kind).toBe(ts.SyntaxKind.QuestionToken);
  expect(declaration.members.nodes[0]!.questionToken).toBe(
    declaration.members.nodes[0]!.postfixToken,
  );
  expect(declaration.members.nodes[1]!.questionToken).toBeUndefined();
  expect(declaration.members.nodes[1]!.postfixToken?.kind).toBe(ts.SyntaxKind.ExclamationToken);
  expect(declaration.members.nodes[2]!.questionToken?.kind).toBe(ts.SyntaxKind.QuestionToken);
  const alias = file.statements.nodes[1]!;
  if (!ts.isTypeAliasDeclaration(alias) || !ts.isMappedTypeNode(alias.type))
    throw new Error("expected mapped type");
  expect(alias.type.questionToken?.kind).toBe(ts.SyntaxKind.MinusToken);
});

test("Node parser shutdown permits a fresh independent session", () => {
  const first = parseSourceFile("input.ts", "export const first = 1;", "ts");
  closeSourceParser();
  const second = parseSourceFile("input.ts", "export const second = 2;", "ts");
  expect(first.text).toBe("export const first = 1;");
  expect(second.text).toBe("export const second = 2;");
});

test("JSDoc callable types cannot replace method body views", () => {
  const { parser } = create();
  const source = `class A {
    /** @type {() => string} */
    callable() { return "first"; }
    /** @type {{ (): number }} */
    signature() { return 2; }
    /** @returns {string} */
    annotated() { return "third"; }
    ordinary() { return true; }
  }`;
  const file = parser.parse("methods.js", source, "js");
  const oracle = ts5.createSourceFile(
    "methods.js",
    source,
    ts5.ScriptTarget.Latest,
    true,
    ts5.ScriptKind.JS,
  );
  const native = file.statements.nodes[0]!;
  const expected = oracle.statements[0]!;
  if (!ts.isClassDeclaration(native) || !ts5.isClassDeclaration(expected))
    throw new Error("expected class");
  expect(
    native.members.nodes.map((member) =>
      member.body === undefined ? undefined : getTextOfNode(member.body),
    ),
  ).toEqual(
    expected.members.map((member) =>
      ts5.isMethodDeclaration(member) ? member.body?.getText() : undefined,
    ),
  );
  for (const member of native.members.nodes) {
    expect(member.body?.kind).toBe(ts.SyntaxKind.Block);
    expect(member.body?.parent).toBe(member);
  }
});

test("a parser starts a new server once it has parsed its source budget, and earlier results stay usable", () => {
  const directory = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-source-parser-"),
  );
  directories.push(directory);
  const servers: Ts7Api[] = [];
  const parser = new Ts7SourceParser(
    (options) => {
      const api = new Ts7Api(options);
      servers.push(api);
      return api;
    },
    directory,
    64,
  );
  parsers.push(parser);
  const first = parser.parse("a.ts", `export const a = ${"1 + ".repeat(20)}1;`, "ts");
  expect(servers).toHaveLength(1);
  const second = parser.parse("b.ts", "export const b = 2;", "ts");
  expect(servers).toHaveLength(2);
  const third = parser.parse("b.ts", "export const b = 3;", "ts");
  expect(servers).toHaveLength(2);
  expect(getTextOfNode(first.statements.nodes[0]!)).toBe(`export const a = ${"1 + ".repeat(20)}1;`);
  expect(getTextOfNode(second.statements.nodes[0]!)).toBe("export const b = 2;");
  expect(getTextOfNode(third.statements.nodes[0]!)).toBe("export const b = 3;");
});
