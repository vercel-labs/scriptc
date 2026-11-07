/* The member table a class instance crosses into an island with: which
 * prototype members the island sees. Builds to IR only (no libnode pack). */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile, type ir } from "@scriptc/compiler";

const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-island-methods-")));

const MAIN = `import { take } from "ni-pkg";

class Base {
  get value(): number {
    return 1;
  }
  set value(v: number) {
    console.log("base", v);
  }
}
class Derived extends Base {
  get value(): number {
    return 2;
  }
}
class Pair extends Base {
  get value(): number {
    return 3;
  }
  set value(v: number) {
    console.log("pair", v);
  }
}

take(new Base());
take(new Derived());
take(new Pair());
`;
const PACKAGE = JSON.stringify({ name: "ni-pkg", version: "1.0.0", main: "index.js" });
const TYPES = `export declare function take(v: unknown): void;\n`;
const IMPL = `exports.take = () => {};\n`;
const PROGRAM = JSON.stringify({
  name: "island-class-methods",
  private: true,
  type: "module",
  scriptc: { packages: { "ni-pkg": "node" } },
});

async function irOf(): Promise<ir.IrModule> {
  const dir = join(cacheDir, "program");
  mkdirSync(join(dir, "node_modules", "ni-pkg"), { recursive: true });
  writeFileSync(join(dir, "main.ts"), MAIN);
  writeFileSync(join(dir, "package.json"), PROGRAM);
  writeFileSync(join(dir, "node_modules", "ni-pkg", "package.json"), PACKAGE);
  writeFileSync(join(dir, "node_modules", "ni-pkg", "index.js"), IMPL);
  writeFileSync(join(dir, "node_modules", "ni-pkg", "index.d.ts"), TYPES);
  const result = await compile(join(dir, "main.ts"), {
    outputKind: "ir",
    outPath: join(dir, "program.ir.json"),
    outDir: dir,
    backend: "llvm",
  });
  if (!result.ok)
    throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
  return JSON.parse(readFileSync(result.artifact.path, "utf8")) as ir.IrModule;
}

/** The keys of the class member table `className` crosses with. */
function memberKeys(mod: ir.IrModule, className: string): string[] {
  const fn = mod.functions.find((f) => f.name === `%island.methods:${className}`);
  if (fn === undefined)
    throw new Error(
      `no member table for ${className}: ${mod.functions
        .map((f) => f.name)
        .filter((n) => n.includes("island"))
        .join(", ")}`,
    );
  const ret = fn.body[0] as { kind: string; value?: { fields?: { key: { value?: string } }[] } };
  return (ret.value?.fields ?? []).map((f) => f.key.value ?? "");
}

afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe("the member table of a class crossing into an island", () => {
  test("a subclass's getter alone leaves the inherited setter out", async () => {
    const mod = await irOf();
    expect(memberKeys(mod, "Base")).toEqual(["get:value", "set:value"]);
    expect(memberKeys(mod, "Derived")).toEqual(["get:value"]);
  });

  test("a subclass that declares both halves keeps both", async () => {
    const mod = await irOf();
    expect(memberKeys(mod, "Pair")).toEqual(["get:value", "set:value"]);
  });
});
