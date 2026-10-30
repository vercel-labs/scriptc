import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** The names of the module's functions and of every call target. */
async function lowered(
  source: string,
): Promise<{ functions: string[]; callees: string[]; keys: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-private-statics-"));
  try {
    const entry = join(dir, "main.js");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const callees: string[] = [];
    const keys: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; callee?: unknown; value?: unknown };
      if (node.kind === "call" && typeof node.callee === "string") callees.push(node.callee);
      if (node.kind === "strLit" && typeof node.value === "string" && node.value.startsWith("#"))
        keys.push(node.value);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return { functions: mod.functions.map((fn) => fn.name), callees, keys };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a static private read through `this` in a runtime static accessor checks the brand", async () => {
  const ir = await lowered(
    `class C {
      static #x = 1;
      static #m() { return 2; }
      static get x() { return this.#x; }
      static get m() { return this.#m; }
    }
    console.log(C.x, C.m());
    `,
  );
  expect(ir.callees).toContain("%private.static.read:C:#x");
  expect(ir.callees).toContain("%private.static.method:C:#m");
  // The private names never become string keys of the class object.
  expect(ir.keys).toEqual([]);
});

test("the declaring class's own name reads native storage without a check", async () => {
  const ir = await lowered(
    `class C {
      static #x = 1;
      static get x() { return C.#x; }
    }
    console.log(C.x);
    `,
  );
  expect(ir.functions.some((name) => name.startsWith("%private.static."))).toBe(false);
  expect(ir.keys).toEqual([]);
});

test("a function-valued static private field called through `this` calls the stored function", async () => {
  const ir = await lowered(
    `class C {
      static #fn = function (a) { return a + 1; };
      static get viaGetter() { return this.#fn(1); }
    }
    console.log(C.viaGetter);
    `,
  );
  expect(ir.callees).toContain("%private.static.read:C:#fn");
  expect(ir.keys).toEqual([]);
});

test("updates of a static private field through `this` check the brand and keep native storage", async () => {
  const ir = await lowered(
    `class C {
      static #n = 1;
      static get bump() {
        this.#n++;
        --this.#n;
        this.#n += 2;
        return this.#n;
      }
    }
    console.log(C.bump);
    `,
  );
  expect(ir.callees).toContain("%private.static.read:C:#n");
  expect(ir.keys).toEqual([]);
});
