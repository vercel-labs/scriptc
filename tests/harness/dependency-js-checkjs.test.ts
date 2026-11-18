/* A dependency's shipped JavaScript is compiled unchecked whatever the
 * project's `checkJs` says. Preflight reports no checker diagnostics for
 * such a file (it is outside the project's own sources), so the lowering has
 * to agree: its JSDoc annotations are hints, and a value the annotation does
 * not admit is stored as Node stores it instead of becoming a checked
 * conversion that throws at run time.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

test("a dependency's JavaScript is compiled unchecked under the project's checkJs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptc-dependency-js-checkjs-"));
  try {
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          checkJs: true,
          allowJs: true,
          noEmit: true,
        },
        include: ["*.ts"],
      }),
    );
    await writeFile(
      join(directory, "lib.js"),
      `/** @type {string} */
export let typed = 1;
/** @type {number} */
export let counted = "two";
export function label() {
  return [typeof typed, typed, typeof counted, counted].join(":");
}
`,
    );
    await writeFile(
      join(directory, "main.ts"),
      'import { label } from "./lib.js";\nconsole.log(label());\n',
    );
    const result = await compile(join(directory, "main.ts"), {
      outDir: directory,
      outPath: join(directory, "app"),
      backend: "llvm",
      optimization: "dev",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const reference = spawnSync(process.execPath, [join(directory, "main.ts")], {
      encoding: "utf8",
    });
    const native = spawnSync(result.binaryPath, [], { encoding: "utf8" });
    expect(reference.stderr).toBe("");
    expect(native.stderr).toBe("");
    expect(native.stdout).toBe(reference.stdout);
    expect(native.status).toBe(reference.status);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
