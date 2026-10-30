// A member read on a union receiver inside an optional-chain body: the
// checker narrows the guarded receiver to ONE union arm (a discriminant
// test through `?.`), while the bound chain value still carries the whole
// present union — the runtime-optional local a prior `if (s?.kind === ...)
// return` narrowed after an `await`. The read must dispatch on the value's
// runtime tag (unionDisc), not fall through to the unsupported-property
// fence the spelled single-record type would suggest.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";

const PRELUDE = [
  "interface ApiKeyCredential { type: 'api_key'; key?: string }",
  "interface OAuthCredential { type: 'oauth'; refresh: string; expires: number }",
  "type Credential = ApiKeyCredential | OAuthCredential;",
];

type IrModule = {
  entry: string;
  functions: { name: string; body: unknown }[];
};

async function compileToIr(
  body: string[],
): Promise<{ ok: boolean; module: IrModule | null; diagnostics: string }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-chain-read-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, [...PRELUDE, ...body].join("\n"));
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      return {
        ok: false,
        module: null,
        diagnostics: result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      };
    const module = deserializeModule(await readFile(outPath, "utf8")) as unknown as IrModule;
    expect(validateModule(module as never)).toEqual([]);
    return { ok: true, module, diagnostics: "" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The IR bodies of the functions whose name starts with `root`, as text
 * (a specialized function keeps its source name as a prefix). */
function bodies(module: IrModule, root: string): string {
  return JSON.stringify(
    module.functions.filter((fn) => fn.name.startsWith(root)).map((fn) => fn.body),
  );
}

test("a chain-guarded union read dispatches on the stored union", async () => {
  const compiled = await compileToIr([
    "function load(): Promise<Credential | undefined> {",
    "  return Promise.resolve({ type: 'api_key', key: 'k' } as Credential);",
    "}",
    "async function pick(): Promise<string> {",
    "  const stored = await load();",
    "  if (stored?.type === 'oauth') return stored.expires > 0 ? 'oauth' : 'expired';",
    "  const credential = stored?.type === 'api_key' ? stored : undefined;",
    "  return credential?.type === 'api_key' ? (credential.key ?? 'none') : 'missing';",
    "}",
    "pick().then((answer) => console.log(answer));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  // The guarded read still sees both stored arms; the tag switch is the
  // shape that composes with the discriminant comparison.
  const pick = bodies(compiled.module!, "pick");
  expect(pick).toContain('"unionDisc"');
  // The runtime-optional local crosses the await, so the presence test is
  // the chain's own guard, not a checked extraction trap on every read.
  expect(pick).not.toContain('"unsupported"');
});

test("a chain-guarded read of a non-discriminant field reads the survivor", async () => {
  const compiled = await compileToIr([
    "function only(c: Credential | undefined): string {",
    "  return c?.type === 'oauth' ? c.refresh : 'api';",
    "}",
    "console.log(only({ type: 'oauth', refresh: 'r', expires: 1 }));",
    "console.log(only(undefined));",
  ]);
  expect(compiled.ok, compiled.diagnostics).toBe(true);
  expect(bodies(compiled.module!, "only")).toContain('"refresh"');
});
