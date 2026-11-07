/* A project with a tsconfig.json is rebuilt from the executable cache.
 *
 * A tsconfig without `include` makes the checker list the project
 * directory, so the build's input observations hold that listing. The build
 * also writes there: its output, and while it runs its private scratch
 * files beside the output. Once those scratch files made every later build
 * a miss, since the listing never matched again. The cases build each
 * project layout twice and expect the second build to restore the
 * executable, then change the tsconfig and expect a build that compiles. */
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cli = join(repoRoot, "packages/cli/dist/main.js");
const windows = process.platform === "win32";

let directory = "";

beforeAll(() => {
  directory = mkdtempSync(join(windows ? tmpdir() : "/tmp", "scriptc-cache-tsconfig-"));
});

afterAll(() => {
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

const STRICT = '{ "compilerOptions": { "strict": true } }\n';

/** A project named `name`: `files` under its directory, the entry among them. */
function project(name: string, files: Record<string, string>): string {
  const root = join(directory, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Builds `entry` to `output` from `cwd` with the cache named `cache`;
 * whether the executable cache answered, from the build's timing lines. */
async function build(
  cwd: string,
  entry: string,
  output: string,
  cache: string,
  env: NodeJS.ProcessEnv = {},
): Promise<"hit" | "miss"> {
  const { stderr } = await execFileAsync(process.execPath, [cli, "build", entry, "-o", output], {
    cwd,
    env: {
      ...process.env,
      SCRIPTC_TIMING: "1",
      SCRIPTC_CACHE_DIR: join(directory, "caches", cache),
      ...env,
    },
    maxBuffer: 1 << 24,
  });
  const phases = [...stderr.matchAll(/"phase":"(executable-cache-(?:hit|miss))"/g)].map(
    (match) => match[1],
  );
  expect(phases, stderr).toHaveLength(1);
  return phases[0] === "executable-cache-hit" ? "hit" : "miss";
}

const MAIN = 'const greeting: string = "configured";\nconsole.log(greeting);\n';

describe.skipIf(windows)("a project with a tsconfig.json", () => {
  test.each([
    // The output beside the entry and its tsconfig.
    ["beside its entry", { "main.ts": MAIN, "tsconfig.json": STRICT }, "main.ts", "app", "."],
    // The output in a directory the tsconfig's file list covers too.
    [
      "with its output in a subdirectory",
      { "main.ts": MAIN, "tsconfig.json": STRICT },
      "main.ts",
      "dist/app",
      ".",
    ],
    // The tsconfig in a parent directory of the entry.
    [
      "in a parent directory",
      { "src/main.ts": MAIN, "tsconfig.json": STRICT },
      "src/main.ts",
      "src/app",
      ".",
    ],
    [
      "in a parent directory, built from the entry's",
      { "src/main.ts": MAIN, "tsconfig.json": STRICT },
      "main.ts",
      "app",
      "src",
    ],
  ])(
    "%s is restored from the cache, and rebuilt when the tsconfig changes",
    { timeout: 600_000 },
    async (name, files, entry, output, from) => {
      const root = project(name.replaceAll(/[^a-z]+/g, "-"), files);
      const cwd = join(root, from);
      const cache = name.replaceAll(/[^a-z]+/g, "-");
      expect(await build(cwd, entry, output, cache)).toBe("miss");
      expect(execFileSync(join(cwd, output), { encoding: "utf8" })).toBe("configured\n");
      expect(await build(cwd, entry, output, cache)).toBe("hit");
      expect(await build(cwd, entry, output, cache)).toBe("hit");
      // With the frontend in this process, the scratch files are other ones.
      expect(await build(cwd, entry, output, cache, { SCRIPTC_FRONTEND_PROCESS: "0" })).toBe("hit");
      // A file of the project's own appearing in the listed directory is a change.
      writeFileSync(join(root, "extra.ts"), "export const extra = 1;\n");
      expect(await build(cwd, entry, output, cache)).toBe("miss");
      expect(await build(cwd, entry, output, cache)).toBe("hit");
      // So is the tsconfig's content, even when it means the same.
      writeFileSync(
        join(root, "tsconfig.json"),
        STRICT.replace('{ "compilerOptions"', '{\n  "compilerOptions"'),
      );
      expect(await build(cwd, entry, output, cache)).toBe("miss");
      expect(await build(cwd, entry, output, cache)).toBe("hit");
      expect(execFileSync(join(cwd, output), { encoding: "utf8" })).toBe("configured\n");
    },
  );

  test("without a tsconfig the second build is a hit as well", { timeout: 600_000 }, async () => {
    const root = project("bare", { "main.ts": MAIN });
    expect(await build(root, "main.ts", "app", "bare")).toBe("miss");
    expect(await build(root, "main.ts", "app", "bare")).toBe("hit");
  });
});
