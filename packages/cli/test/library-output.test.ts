import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, "../../..");
const cliEntry = join(repoRoot, "packages/cli/src/main.ts");
const tsxLoader = join(dirname(require.resolve("tsx/package.json")), "dist/loader.mjs");

test("library identity source stays private and cannot overwrite a sidecar", async () => {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = await mkdtemp(join(tempRoot, "scriptc-cli-library-output-"));
  const cacheRoot = join(dir, "cache");
  const outDir = join(dir, ".scriptc");
  const profilePath = join(dir, "profile.json");
  try {
    await mkdir(cacheRoot, { mode: 0o700 });
    await writeFile(join(dir, "lib.ts"), [
      "export interface Model { value: number; }",
      "export type Msg = { kind: \"noop\" } | { kind: \"set\"; value: number };",
      "export function init(): Model { return { value: 1 }; }",
      "export function update(model: Model, msg: Msg): Model {",
      "  return msg.kind === \"set\" ? { value: msg.value } : model;",
      "}",
      "export function boot(): number { return init().value; }",
      "",
    ].join("\n"));

    const writeProfile = (sidecarPath: string): Promise<void> => writeFile(
      profilePath,
      `${JSON.stringify({
        profile_format: 1,
        name: "cli-library-output",
        entry: "lib.ts",
        emission: "c",
        abi: {
          prefix: "clo_",
          init_symbol: "clo_init",
          sink_register_symbol: "clo_set_panic_sink",
          collect_symbol: null,
          result_reset_symbol: null,
        },
        exports: [{ export: "boot", symbol: "clo_boot", params: [], returns: "f64" }],
        sidecar: {
          path: sidecarPath,
          wire_version: 1,
          abi_version: 1,
          snapshot_format: 1,
          build_id_symbol: "clo_build_id",
          abi_version_symbol: "clo_abi_version",
          model: "Model",
          msg: "Msg",
        },
      }, null, 2)}\n`,
    );
    const runBuild = async (): Promise<void> => {
      await execFileAsync(
        process.execPath,
        ["--import", tsxLoader, cliEntry, "build", "--lib", "--profile", profilePath, "--no-keep-c"],
        {
          env: {
            ...process.env,
            TMPDIR: tempRoot,
            SCRIPTC_CACHE_DIR: cacheRoot,
          },
          maxBuffer: 1024 * 1024,
        },
      );
    };

    // --no-keep-c removes the public program TU, and the identity source is
    // invocation-private rather than a second caller-visible C artifact.
    await writeProfile("contract.json");
    await runBuild();
    expect((await readdir(outDir)).sort()).toEqual(["contract.json", "lib.lib.a"]);

    // This name collided with the former fixed `<stem>.lib.identity.c`
    // output. Repeat to exercise the exact early-cache-hit ordering that used
    // to restore JSON and then overwrite it with generated C.
    await rm(outDir, { recursive: true, force: true });
    await writeProfile("lib.lib.identity.c");
    await runBuild();
    await runBuild();
    const sidecar = JSON.parse(await readFile(join(outDir, "lib.lib.identity.c"), "utf8")) as {
      build_id?: unknown;
    };
    expect(sidecar.build_id).toMatch(/^[0-9a-f]{16}$/);
    expect((await readdir(outDir)).sort()).toEqual(["lib.lib.a", "lib.lib.identity.c"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
