import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { nodeFrontendServices } from "./services-node.js";
import { npmStaticTypeExportPlan } from "./npm-static-type-exports-host.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A program directory with one package whose .d.ts is `declarations`;
 * returns the program's entry path. */
function fixture(declarations: string): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-type-exports-"));
  dirs.push(dir);
  const lib = join(dir, "node_modules", "pkg", "lib");
  mkdirSync(lib, { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "pkg", "package.json"),
    JSON.stringify({ name: "pkg", main: "./lib/index.js", types: "./lib/index.d.ts" }),
  );
  writeFileSync(join(lib, "index.d.ts"), declarations);
  writeFileSync(join(lib, "index.js"), "exports.grow = function grow(into) {};\n");
  writeFileSync(join(dir, "main.ts"), 'import { grow } from "pkg";\n');
  return join(dir, "main.ts");
}

/** The type names the runtime entry's typedefs re-export. */
function reexported(entry: string): string[] {
  const plan = npmStaticTypeExportPlan(nodeFrontendServices(), entry, ["pkg"]);
  const block = [...plan.typedefs.values()].join("\n");
  return [...block.matchAll(/@typedef \{[^}]*\} (\w+)/g)].map((m) => m[1]!);
}

test("only data shapes are re-exported", () => {
  const entry = fixture(`export interface Point { x: number; y: number }
export interface Handle { close(): void }
export type Label = { text: string; at: Point };
export type Callback = (point: Point) => void;
export interface Holder { handle: Handle }
export declare function grow(into: Point[]): void;
`);
  expect(reexported(entry)).toEqual(["Point", "Label"]);
});

test("mutually recursive types are data shapes only when every type they reach is", () => {
  // Branch is checked first and reaches Tree, which refers back to Branch:
  // Tree is a data shape only if Branch is, and Branch holds a Handle.
  const entry = fixture(`export interface Branch { child: Tree; handle: Handle }
export interface Tree { name: string; parent: Branch | null }
export interface Handle { close(): void }
export interface Node { value: number; next: List }
export interface List { head: Node | null }
export declare function grow(into: Tree[]): void;
`);
  expect(reexported(entry)).toEqual(["Node", "List"]);
});
