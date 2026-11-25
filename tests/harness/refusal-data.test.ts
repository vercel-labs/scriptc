import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { NODE_BUILTIN_MODULES_V24 } from "../../packages/compiler/src/frontend/builtin-modules.js";
import {
  buildRefusals,
  REFUSALS_SCHEMA_VERSION,
  renderRefusals,
  unsupportedBuiltinModules,
} from "../../internal/compatibility/src/refusals.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

type Binding =
  | "unknown"
  | {
      module: string;
      path?: string[];
      access: "call" | "get" | "construct" | "listen" | "import";
    };

interface Refusal {
  row?: string;
  layer: "static" | "load";
  binding: Binding;
  chapter?: string;
  apiSymbol?: string;
  code?: string;
  message?: string;
}

interface Refusals {
  schemaVersion: number;
  nodeVersion: string;
  compilerVersion: string;
  refusals: Refusal[];
}

const internalPath = "internal/compatibility/generated/node-v24-refusals.json";
const publishedPath = "packages/experimental/refusals.json";
const committed = read(internalPath);
const table = JSON.parse(committed) as Refusals;
const pin = readJson<{ version: string; chapterModules: Record<string, string[]> }>(
  "internal/compatibility/node-v24.json",
);
const compilerVersion = readJson<{ version: string }>("packages/compiler/package.json").version;
const ledger = readJson<{
  rows: Array<{ id: string; static?: { status?: string; evidence?: string } }>;
}>("internal/compatibility/generated/node-v24-internal.json");

const fresh = renderRefusals(
  buildRefusals(ledger, { chapterModules: pin.chapterModules, compilerVersion }),
);

describe("refusal table", () => {
  test("the committed table regenerates byte-identically from the ledger", () => {
    expect(
      committed,
      `${internalPath} is stale; run 'pnpm node-compat' and commit the result`,
    ).toBe(fresh);
  });

  test("the published copy is the generated table", () => {
    expect(read(publishedPath)).toBe(committed);
  });

  test("names the schema, the Node pin, and the compiler version it was built for", () => {
    expect(table.schemaVersion).toBe(REFUSALS_SCHEMA_VERSION);
    expect(table.nodeVersion).toBe(pin.version);
    expect(table.compilerVersion).toBe(compilerVersion);
  });

  test("covers every explicit refusal row in the ledger", () => {
    const refusedRows = ledger.rows.filter(
      (row) =>
        row.static?.status === "refused" &&
        row.static.evidence?.startsWith("surface-manifest:unsupported:"),
    );
    const staticEntries = table.refusals.filter((entry) => entry.layer === "static");

    expect(staticEntries.map((entry) => entry.row).sort()).toEqual(
      refusedRows.map((row) => row.id).sort(),
    );
    for (const entry of staticEntries) {
      expect(entry.chapter).toBeTruthy();
      expect(entry.apiSymbol).toBeTruthy();
    }
  });

  test("places every static refusal on a builtin module access", () => {
    const nodeModules = new Set(
      NODE_BUILTIN_MODULES_V24.map((name) => (name.startsWith("node:") ? name : `node:${name}`)),
    );
    for (const entry of table.refusals.filter((item) => item.layer === "static")) {
      expect(entry.binding, entry.apiSymbol).not.toBe("unknown");
      if (entry.binding === "unknown") continue;
      expect(Array.isArray(entry.binding.path)).toBe(true);
      expect(entry.binding.path?.length ?? 0).toBeGreaterThan(0);
      expect(["call", "get", "construct", "listen", "import"]).toContain(entry.binding.access);
      // The binding names one of Node's modules, not a chapter or a docs
      // symbol prefix.
      expect(nodeModules.has(entry.binding.module), entry.binding.module).toBe(true);
    }
  });

  test("lists every fenced builtin module once with the compiler's code and message", () => {
    const loadEntries = table.refusals.filter((entry) => entry.layer === "load");
    const expected = unsupportedBuiltinModules();
    const modules = loadEntries.map((entry) =>
      entry.binding === "unknown" ? "" : entry.binding.module.replace(/^node:/, ""),
    );

    expect(modules).toEqual(expected);
    expect(new Set(modules).size).toBe(modules.length);
    for (const entry of loadEntries) {
      if (entry.binding === "unknown") {
        expect.fail("a load refusal always names its module");
      }
      expect(entry.binding.access).toBe("import");
      expect(entry.binding.path).toBeUndefined();
      expect(entry.code).toBe("SC1010");
      expect(entry.message).toContain(`'${entry.binding.module}'`);
      expect(entry.message?.endsWith("not supported yet")).toBe(true);
    }
  });

  test("builds the same table twice", () => {
    expect(
      renderRefusals(
        buildRefusals(ledger, { chapterModules: pin.chapterModules, compilerVersion }),
      ),
    ).toBe(fresh);
  });
});
