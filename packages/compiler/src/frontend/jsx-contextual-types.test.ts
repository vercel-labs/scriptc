import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { jsxEmitPlan, jsxPragmas, lowerJsx } from "./jsx-source.js";
import { checkPreflight, loadProgram } from "./program-node.js";
import * as ts from "./ts7/adapter.js";
import { parseSourceFile } from "./ts7/source-parser-node.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A project whose JSX runtime types the attribute callbacks, with the
 * extension the test file uses for its entry. */
function project(file: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "scriptc-jsx-context-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      type: "module",
      imports: {
        "#jsx": "./runtime/index.ts",
        "#jsx/jsx-runtime": "./runtime/jsx-runtime.ts",
      },
    }),
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        strict: true,
        module: "nodenext",
        jsx: "react-jsx",
        jsxImportSource: "#jsx",
        noEmit: true,
      },
    }),
  );
  mkdirSync(join(directory, "runtime"), { recursive: true });
  writeFileSync(join(directory, "runtime", "index.ts"), "export const name = '#jsx';\n");
  writeFileSync(
    join(directory, "runtime", "jsx-runtime.ts"),
    [
      "export interface Props { [name: string]: unknown }",
      "export interface Element { type: string | ((props: any) => Element); props: Props; key: string | undefined }",
      "export const Fragment = '#fragment';",
      "export function jsx(type: string | ((props: any) => Element), props: Props, key?: unknown): Element {",
      "  return { type, props, key: key === undefined ? undefined : String(key) };",
      "}",
      "export const jsxs = jsx;",
      "export namespace JSX {",
      "  export type Element = import('./jsx-runtime.js').Element;",
      "  export interface ElementChildrenAttribute { children: {} }",
      "  export interface IntrinsicElements {",
      "    button: { onClick?: (event: { x: number; label: string }) => void; children?: unknown; key?: unknown };",
      "    div: { children?: unknown; key?: unknown };",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  mkdirSync(join(directory, "app"), { recursive: true });
  const entry = join(directory, "app", file);
  writeFileSync(entry, source);
  return entry;
}

/** The type of every parameter named `event` in the lowering program. */
function parameterTypes(load: ReturnType<typeof loadProgram>, entry: string): string[] {
  const program = load.program;
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  if (sf === undefined) return [];
  const types: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "event")
      types.push(checker.typeToString(checker.getTypeAtLocation(node.name)));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return types;
}

test("an inline JSX callback keeps the attribute's parameter types", () => {
  const source = `export const a = <button onClick={(event) => event.x + event.label.length} />;\n`;
  const entry = project("app.tsx", source);
  const load = loadProgram(entry);
  try {
    const lowered = load.jsxSources?.get(entry);
    expect(lowered).toBeDefined();
    expect(lowered!.text).toContain(") as ((event: { x: number; label: string; }) => void)");
    expect(checkPreflight(load)).toEqual([]);
    // The arrow's parameter and the cast type's parameter both read
    // through the JSX attribute type.
    expect(parameterTypes(load, entry)).toEqual([
      "{ x: number; label: string; }",
      "{ x: number; label: string; }",
    ]);
  } finally {
    load.dispose();
  }
});

test("an inline JSX callback in JavaScript keeps its current lowering", () => {
  const source = `export const a = <button onClick={(event) => event.x} />;\n`;
  const entry = project("app.jsx", source);
  const load = loadProgram(entry);
  try {
    const lowered = load.jsxSources?.get(entry);
    expect(lowered).toBeDefined();
    expect(lowered!.text).not.toContain(") as ");
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    load.dispose();
  }
});

test("a callback the JSX site does not type is left alone", () => {
  const source = `const items = [1, 2];\nexport const a = <div>{items.map((event) => event)}</div>;\n`;
  const entry = project("app.tsx", source);
  const load = loadProgram(entry);
  try {
    const lowered = load.jsxSources?.get(entry);
    expect(lowered).toBeDefined();
    expect(lowered!.text).not.toContain(") as ");
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    load.dispose();
  }
});

test("a file whose slots need no contextual types rewrites exactly as before", () => {
  const source = [
    "const items = [1, 2];",
    "const onClick = (event: { button: number }) => event.button;",
    "export const a = <button onClick={onClick} />;",
    "export const b = <div>{items.map((item) => item)}</div>;",
    "",
  ].join("\n");
  const entry = project("app.tsx", source);
  const load = loadProgram(entry);
  try {
    const lowered = load.jsxSources?.get(entry);
    const plan = jsxEmitPlan({ jsx: "react-jsx", jsxImportSource: "#jsx" }, jsxPragmas(source));
    expect(lowered!.text).toBe(lowerJsx(parseSourceFile(entry, source, "tsx"), plan).text);
  } finally {
    load.dispose();
  }
});

test("a component's module-private callback type keeps the slot typed", () => {
  const entry = project(
    "app.tsx",
    [
      'import { Row, Slot } from "./widgets.js";',
      "export const picked: string[] = [];",
      "export const row = <Row onPick={(event) => picked.push(`${event.id}:${event.label}`)} />;",
      "export const spread = <Row {...{ onPick: (event) => picked.push(String(event.id)) }} />;",
      "export const slot = <Slot title='s'>{(event) => picked.push(event.label)}</Slot>;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dirname(entry), "widgets.tsx"),
    [
      "interface PickEvent { id: number; label: string }",
      "interface RowProps { onPick?: (event: PickEvent) => void }",
      "export function Row(props: RowProps) {",
      "  return <button onClick={() => props.onPick?.({ id: 1, label: 'x' })} />;",
      "}",
      "export function Slot(props: { title: string; children: (event: PickEvent) => void }) {",
      "  return <div>{props.title}</div>;",
      "}",
      "",
    ].join("\n"),
  );
  const load = loadProgram(entry);
  try {
    // The emitted constraint reads the props type through the tag, because
    // `PickEvent` is not visible from this file.
    const lowered = load.jsxSources?.get(entry);
    expect(lowered!.text).toContain(`NonNullable<Parameters<typeof Row>[0]>["onPick"]`);
    expect(lowered!.text).toContain(
      `Partial<NonNullable<Parameters<typeof Row>[0]> & { ref?: any; key?: any }>`,
    );
    expect(lowered!.text).toContain(`NonNullable<Parameters<typeof Slot>[0]>["children"]`);
    expect(checkPreflight(load)).toEqual([]);
  } finally {
    load.dispose();
  }
});
