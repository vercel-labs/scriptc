import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

const supported = process.platform === "darwin" && process.arch === "arm64" &&
  Number.parseInt(osRelease().split(".", 1)[0] ?? "", 10) >= 24;
const repoRoot = join(import.meta.dirname, "../..");
const fixture = join(repoRoot, "examples/native-object");
const scratch = mkdtempSync(join(tmpdir(), "scriptc-native-object-example-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.runIf(supported)("external native object example", () => {
  test("rejects a stale runtime pack before invoking the toolchain", () => {
    const runtimeRoot = join(scratch, "stale-runtime");
    const traps = join(scratch, "stale-traps");
    const trapLog = join(scratch, "stale-toolchain.log");
    const linkInfo = join(scratch, "stale-link-info.json");
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(traps, { recursive: true });
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({
      name: "@scriptc/runtime",
      version: "2.0.0",
    }));
    const clang = join(traps, "clang");
    writeFileSync(clang, `#!/bin/sh\nprintf invoked > '${trapLog}'\nexit 97\n`);
    chmodSync(clang, 0o755);
    writeFileSync(linkInfo, JSON.stringify({
      schema: "scriptc.native-link-info.v1",
      runtime_pack: {
        package: "@scriptc/runtime",
        version: "1.0.0",
        root: runtimeRoot,
        source_sets: [],
      },
      program: { object: join(scratch, "missing.o") },
      ffi: { libraries: [] },
      link: { driver_flags: [], system_libraries: [], frameworks: [] },
    }));

    let failure: { stderr?: Buffer } | null = null;
    try {
      execFileSync(process.execPath, [
        join(fixture, "link.mjs"), "cc", linkInfo, join(scratch, "stale-program"),
      ], {
        env: { ...process.env, PATH: `${traps}:${process.env["PATH"] ?? ""}` },
        stdio: "pipe",
      });
    } catch (error) {
      failure = error as { stderr?: Buffer };
    }
    expect(failure?.stderr?.toString("utf8")).toContain(
      "runtime pack identity mismatch: expected @scriptc/runtime@1.0.0",
    );
    expect(existsSync(trapLog)).toBe(false);
  });

  test("links and runs through both the C driver and Apple ld", () => {
    const nativeObject = join(scratch, "native.o");
    const programObject = join(scratch, "app.o");
    const manifest = join(scratch, "ffi.json");
    const linkInfo = join(scratch, "link-info.json");
    const raw = JSON.parse(readFileSync(join(fixture, "ffi.json"), "utf8")) as { libraries: string[] };
    raw.libraries = [nativeObject];
    writeFileSync(manifest, JSON.stringify(raw));
    execFileSync("clang", [
      "-target", "arm64-apple-macosx14.0.0", "-O2", "-c",
      join(fixture, "native.c"), "-o", nativeObject,
    ]);
    const json = execFileSync("node", [
      join(repoRoot, "packages/cli/dist/main.js"),
      "build", join(fixture, "main.ts"),
      "--ffi", manifest,
      "--print=native-link-info", "-o", programObject,
    ], { encoding: "utf8" });
    writeFileSync(linkInfo, json);

    for (const mode of ["cc", "ld"] as const) {
      const executable = join(scratch, `app-${mode}`);
      execFileSync("node", [join(fixture, "link.mjs"), mode, linkInfo, executable]);
      expect(execFileSync(executable, [], { encoding: "utf8" })).toBe("42\n");
    }
  }, 60_000);
});
