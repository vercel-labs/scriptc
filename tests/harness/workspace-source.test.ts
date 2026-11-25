import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/workspace-source/main.ts");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests/workspace-source");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test.for(["llvm"] as const)(
  "a TypeScript-source workspace package compiles as program modules with the %s backend",
  async (backend) => {
    const outDir = join(cacheDir, `${backend}-${sanitize ? "san" : "plain"}`);
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, {
      outPath: join(outDir, "program"),
      outDir,
      backend,
      sanitize,
    });
    if (!result.ok) {
      throw new Error(
        result.diagnostics
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
          .join("\n"),
      );
    }

    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("wssource:linked:6\n");
  },
  120_000,
);

// The scriptc export condition selects the branch a TypeScript workspace
// package, the program's own package and its package imports publish for
// scriptc, whatever place each map gives the key. The checker types the same
// file the program compiles: the adapter's own exports are importable.
// Node.js has no such condition, so it runs the default branches; the native
// answer is asserted directly.
test("the scriptc export condition selects the TypeScript sources the checker types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-condition-sources-"));
  try {
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    const branches = (base: string) => ({
      default: `${base}/index.ts`,
      scriptc: `${base}/adapter.ts`,
    });
    write(
      "package.json",
      JSON.stringify({
        name: "adapter-app",
        type: "module",
        workspaces: ["packages/*"],
        exports: { ".": branches("./src") },
        imports: { "#impl": branches("./impl") },
      }),
    );
    write(
      "packages/lib/package.json",
      JSON.stringify({ name: "lib", type: "module", exports: { ".": branches("./src") } }),
    );
    for (const [base, name] of [
      ["src", "self"],
      ["impl", "impl"],
      ["packages/lib/src", "lib"],
    ] as const) {
      write(`${base}/index.ts`, `export const ${name}: string = "default";\n`);
      write(
        `${base}/adapter.ts`,
        `export const ${name}: string = "scriptc";\nexport const ${name}Only: number = 1;\n`,
      );
    }
    mkdirSync(join(dir, "node_modules"));
    symlinkSync("../packages/lib", join(dir, "node_modules/lib"));
    write(
      "main.ts",
      [
        'import { lib, libOnly } from "lib";',
        'import { self, selfOnly } from "adapter-app";',
        'import { impl, implOnly } from "#impl";',
        "console.log(lib, self, impl, libOnly + selfOnly + implOnly);",
        "",
      ].join("\n"),
    );
    const result = await compile(join(dir, "main.ts"), {
      outPath: join(dir, "program"),
      outDir: join(dir, "out"),
      backend: "llvm",
      sanitize,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    expect(stdout).toBe("scriptc scriptc scriptc 3\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
