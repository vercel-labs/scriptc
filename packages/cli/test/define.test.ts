import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const bootstrapEntry = join(repoRoot, "packages/cli/dist/bootstrap.js");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

async function withProgram(
  files: Record<string, string>,
  run: (
    dir: string,
    scriptc: (args: string[], bootstrap?: boolean) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-define-"));
  const env = { ...process.env, SCRIPTC_CACHE_DIR: join(dir, "cache") };
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    await run(dir, async (args, bootstrap = false) => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [...(bootstrap ? [bootstrapEntry] : ["--import", tsxLoader, cliEntry]), ...args],
        { env, cwd: dir },
      );
      return stdout;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const program = {
  "main.cjs": `const mode = process.env.NODE_ENV;
console.log(mode === "production" ? "production build" : "other build", mode);
`,
};

test("--define sets the variable, and builds with and without it keep their own cached executables", async () => {
  await withProgram(program, async (dir, scriptc) => {
    const executable = join(dir, "program");
    const run = async (): Promise<string> =>
      (await execFileAsync(executable, [], { env: { ...process.env, NODE_ENV: "development" } }))
        .stdout;
    const define = `--define=process.env.NODE_ENV="production"`;
    await scriptc(["build", "main.cjs", "-o", executable, define]);
    expect(await run()).toBe("production build production\n");
    // The bootstrap's cached route of a build without the flag.
    await scriptc(["build", "main.cjs", "-o", executable], true);
    expect(await run()).toBe("other build development\n");
    await scriptc(["build", "main.cjs", "-o", executable, define]);
    expect(await run()).toBe("production build production\n");
  });
}, 240_000);

test("scriptc run and coverage honor --define, and coverage keeps separate verdicts", async () => {
  await withProgram(
    {
      "main.cjs": `"use strict";
if (process.env.NODE_ENV === "production") {
  module.exports = require("./production.cjs");
} else {
  module.exports = require("./development.cjs");
}
console.log(module.exports.mode);
`,
      "production.cjs": `exports.mode = "production build";\n`,
      "development.cjs": `exports.mode = "development build";\n`,
    },
    async (_dir, scriptc) => {
      const define = `--define=process.env.NODE_ENV="production"`;
      expect(await scriptc(["run", "main.cjs", define])).toBe("production build\n");
      const refusal = "replacing module.exports outside a top-level statement";
      expect(await scriptc(["coverage", "main.cjs", define])).not.toContain(refusal);
      // The bootstrap's replayed verdict of a coverage run without the flag.
      expect(await scriptc(["coverage", "main.cjs"], true)).toContain(refusal);
      expect(await scriptc(["coverage", "main.cjs", define])).not.toContain(refusal);
    },
  );
}, 240_000);

test("--define values must name process.env variables and be JSON strings", async () => {
  await withProgram(program, async (_dir, scriptc) => {
    const refused = async (arg: string, message: string): Promise<void> => {
      await expect(scriptc(["build", "main.cjs", "-o", "program", arg]), arg).rejects.toThrow(
        message,
      );
    };
    await refused(
      "--define=process.env.NODE_ENV=production",
      `--define=process.env.NODE_ENV=production: process.env.NODE_ENV is a string, so its value must be a JSON string: --define='process.env.NODE_ENV="production"'`,
    );
    await refused(
      "--define=process.env.PORT=8080",
      `process.env.PORT is a string, so its value must be a JSON string: --define='process.env.PORT="8080"'`,
    );
    await refused("--define=process.env.NODE_ENV", "expected <name>=<value>");
    await refused(
      `--define=__DEV__=false`,
      "defining '__DEV__' is not supported yet (only process.env.NAME)",
    );
    await expect(
      scriptc([
        "build",
        "main.cjs",
        "-o",
        "program",
        `--define=process.env.NODE_ENV="production"`,
        `--define=process.env.NODE_ENV="development"`,
      ]),
    ).rejects.toThrow("--define: process.env.NODE_ENV is defined twice with different values");
    await expect(
      scriptc([
        "build",
        "--lib",
        "--profile",
        "p.json",
        `--define=process.env.NODE_ENV="production"`,
      ]),
    ).rejects.toThrow("scriptc build --lib takes no");
  });
}, 240_000);

test("--define refuses changing a defined variable", async () => {
  await withProgram(
    {
      "main.ts": `process.env.NODE_ENV = "development";
process.env["NODE_ENV"] = "development";
delete process.env.NODE_ENV;
process.env.OTHER = "changed";
console.log(process.env.OTHER);
`,
    },
    async (_dir, scriptc) => {
      const build = scriptc([
        "build",
        "main.ts",
        "-o",
        "program",
        `--define=process.env.NODE_ENV="production"`,
      ]);
      await expect(build).rejects.toThrow(
        /main\.ts:1:1 - error SC1090: changing process\.env\.NODE_ENV when --define fixes its value is not supported yet[\s\S]*main\.ts:2:1 - error SC1090[\s\S]*main\.ts:3:8 - error SC1090[\s\S]*3 errors/,
      );
    },
  );
}, 240_000);
