// `(value as Wider | undefined)?.member`, where only the asserted type
// declares `member`: the chain's guard binds the record the value holds
// when present, and the member is read off that record's kept source, never
// as a field of a layout that has no such slot. The differential case is
// tests/corpus/8822-asserted-optional-chain-member-read.ts.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

type Node = { kind?: string; [key: string]: unknown };
type IrModule = { functions: { name: string; body: unknown }[] };

const PRELUDE = [
  "interface Token { kind: string; access: string }",
  "type Gateway = { baseUrl: string };",
  "type GatewayToken = Token & { gateway?: Gateway };",
  "function show(g: Gateway | undefined): string {",
  '  return g === undefined ? "none" : g.baseUrl;',
  "}",
];

async function compileToIr(
  body: string[],
): Promise<{ module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-asserted-chain-read-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [...PRELUDE, ...body].join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Every IR node of `kind` under `root`. */
function nodesOf(root: unknown, kind: string, found: Node[] = []): Node[] {
  if (Array.isArray(root)) for (const item of root) nodesOf(item, kind, found);
  else if (root !== null && typeof root === "object") {
    const node = root as Node;
    if (node.kind === kind) found.push(node);
    for (const value of Object.values(node)) nodesOf(value, kind, found);
  }
  return found;
}

test("an asserted-only member behind an optional chain is not read as a field", async () => {
  const compiled = await compileToIr([
    "function gatewayOf(token: Token | undefined): string {",
    "  return show((token as GatewayToken | undefined)?.gateway);",
    "}",
    'console.log(gatewayOf(undefined), gatewayOf({ kind: "oauth", access: "a" }));',
  ]);
  expect(compiled.module, compiled.diagnostics).not.toBeNull();
  const fn = compiled.module!.functions.find((candidate) => candidate.name === "gatewayOf");
  expect(fn).toBeDefined();
  expect(nodesOf(fn!.body, "optChain")).toHaveLength(1);
  expect(nodesOf(fn!.body, "recordGet").filter((get) => get["field"] === "gateway")).toEqual([]);
});

test("the non-null spelling over a nullable value is refused by name", async () => {
  const compiled = await compileToIr([
    "function gatewayOf(token: Token | undefined): string {",
    "  return show((token as GatewayToken | undefined)!.gateway);",
    "}",
    'console.log(gatewayOf({ kind: "oauth", access: "a" }));',
  ]);
  expect(compiled.module).toBeNull();
  expect(compiled.diagnostics).toContain("SC1090");
  expect(compiled.diagnostics).toContain(
    "reading 'gateway' through a non-null assertion over a type assertion",
  );
  expect(compiled.diagnostics).not.toContain("SC9001");
});
