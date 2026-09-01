import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release as osRelease, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");
const supported = process.platform === "darwin" && process.arch === "arm64" &&
  Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) >= 24;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.runIf(supported)("precompiled runtime executable builds", () => {
  test("ordinary LLVM executables invoke the linker but no C compiler mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-cli-"));
    dirs.push(dir);
    const entry = join(dir, "main.ts");
    const output = join(dir, "program");
    const wrapper = join(dir, "linker");
    const log = join(dir, "linker.json");
    await writeFile(entry, 'console.log("precompiled runtime");\n');
    await writeFile(wrapper, [
      "#!/bin/sh",
      `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' '${log}' \"$@\"`,
      "exec clang \"$@\"",
      "",
    ].join("\n"));
    await chmod(wrapper, 0o755);
    const cliArgs = [
      "--import", tsxLoader, cliEntry, "build", entry, "-o", output,
    ];
    const env = {
      ...process.env,
      SCRIPTC_NO_CACHE: "1",
      SCRIPTC_LINKER: wrapper,
    };
    await execFileAsync(process.execPath, cliArgs, {
      env: {
        ...env,
      },
    });
    const args = JSON.parse(await readFile(log, "utf8")) as string[];
    expect(args).not.toContain("-c");
    expect(args.some((arg) => arg.endsWith(".c") || arg.endsWith(".ll"))).toBe(false);
    expect(args.some((arg) =>
      arg.includes("scriptc-runtime-pack-link-") && arg.includes("/artifacts/")
    )).toBe(true);
    expect(args.some((arg) => arg.includes("runtime-darwin-arm64/artifacts"))).toBe(false);
    await expect(execFileAsync(output, [], { encoding: "utf8" }))
      .resolves.toMatchObject({ stdout: "precompiled runtime\n" });
    const firstExecutable = await readFile(output);
    const signature = await execFileAsync("codesign", ["-dvvv", output], { encoding: "utf8" });
    expect(signature.stderr).toContain(`Identifier=${basename(output)}`);

    await execFileAsync(process.execPath, cliArgs, { env });
    expect(await readFile(output)).toEqual(firstExecutable);
  });

  test("the object-plus-runtime-pack route remains live with the legacy C pipeline disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-runtime-pack-no-legacy-"));
    dirs.push(dir);
    const entry = join(dir, "main.ts");
    const output = join(dir, "program");
    await writeFile(entry, 'console.log("no legacy C");\n');
    await execFileAsync(
      process.execPath,
      ["--import", tsxLoader, cliEntry, "build", entry, "-o", output],
      {
        env: {
          ...process.env,
          SCRIPTC_NO_CACHE: "1",
          SCRIPTC_LEGACY_C_PIPELINE: "0",
        },
      },
    );
    await expect(execFileAsync(output, [], { encoding: "utf8" }))
      .resolves.toMatchObject({ stdout: "no legacy C\n" });
  });
});
