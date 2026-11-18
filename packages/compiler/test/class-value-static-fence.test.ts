/* A class value installs its static members as functions on a checked-dynamic
 * property table. A member whose declared signature has no checked-dynamic
 * form (three's runtime `Response` statics are one example) used to produce
 * malformed IR or a refused lowering that escaped the compiler. The class
 * value still exists in Node, and a static the program never calls must not
 * fail the build: the table installs a function that throws the refusal where
 * the member is called.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const programs: Record<string, [string, string]> = {
  "a static method whose parameter is a record with an accessor": [
    `
class C { static m(a: { get x(): number }) { return a.x; } }
const c: any = C;
console.log("value", typeof c, typeof c.m);
`,
    "value function function\n",
  ],
  "a static setter whose parameter cannot be a checked value": [
    `
class C { static set x(v: () => { get y(): number }) { void v; } }
const c: any = C;
const entry = Object.getOwnPropertyDescriptor(c, "x")!;
console.log("value", typeof c, typeof entry.set);
`,
    "value function function\n",
  ],
  "a static method whose callback returns an unboxable record": [
    `
class C { static m(cb: () => { get y(): number }) { void cb; } }
const c: any = C;
console.log("value", typeof c, typeof c.m);
`,
    "value function function\n",
  ],
};

test("a static returning a dynamic import keeps its namespace-promise adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-class-value-fence-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await writeFile(join(directory, "mod.js"), "export const answer = 42;\n");
    await writeFile(
      join(directory, "main.ts"),
      `class C { static load() { return import("./mod.js"); } }
const c: any = C;
console.log("value", typeof c, typeof c.load);
`,
    );
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "app"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe("value function function\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.for(Object.entries(programs))("%s", async ([name, [source, expected]]) => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-class-value-fence-"));
  try {
    await writeFile(join(directory, "main.ts"), source);
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "app"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(
        `${name}: ${result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n")}`,
      );
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(native.stderr).toBe("");
    expect(native.status).toBe(0);
    expect(native.stdout).toBe(expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
