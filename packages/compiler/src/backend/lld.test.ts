import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { driverFindsLld, inputsWithoutLld, lldLinkerArgs } from "./lld.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tool(path: string): string {
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "scriptc-lld-"));
  directories.push(root);
  const llvm = join(root, "llvm", "bin");
  const usr = join(root, "usr", "bin");
  const other = join(root, "other");
  for (const directory of [llvm, usr, other]) mkdirSync(directory, { recursive: true });
  return { root, llvm, usr, other };
}

test.skipIf(process.platform === "win32")(
  "a driver finds ld.lld beside itself, beside its real executable, or on PATH",
  () => {
    const f = fixture();
    const clang = tool(join(f.llvm, "clang"));
    // Without ld.lld anywhere.
    expect(driverFindsLld(clang, { PATH: f.other })).toBe(false);
    // Beside the driver.
    tool(join(f.llvm, "ld.lld"));
    expect(driverFindsLld(clang, { PATH: f.other })).toBe(true);
    // A PATH entry that links to the driver: clang looks beside its real executable.
    symlinkSync(clang, join(f.usr, "clang"));
    expect(driverFindsLld("clang", { PATH: f.usr })).toBe(true);
    // A driver elsewhere finds ld.lld on PATH, and not otherwise.
    const gcc = tool(join(f.other, "gcc"));
    expect(driverFindsLld(gcc, { PATH: f.other })).toBe(false);
    expect(driverFindsLld(gcc, { PATH: [f.other, f.llvm].join(":") })).toBe(true);
    expect(driverFindsLld("missing-driver", { PATH: f.llvm })).toBe(false);
  },
);

test.skipIf(process.platform === "win32")(
  "Linux links with the default driver use lld when the driver finds it",
  () => {
    const f = fixture();
    const clang = tool(join(f.llvm, "clang"));
    tool(join(f.llvm, "ld.lld"));
    const env = { PATH: f.other };
    expect(lldLinkerArgs("linux", clang, env)).toEqual(["-fuse-ld=lld"]);
    expect(lldLinkerArgs("darwin", clang, env)).toEqual([]);
    expect(lldLinkerArgs("windows", clang, env)).toEqual([]);
    expect(lldLinkerArgs("linux", clang, { ...env, SCRIPTC_LINKER: clang })).toEqual([]);
  },
);

test("Linux links without lld leave out the glibc math unit", () => {
  const inputs = ["/pack/scr_lib.o", "/pack/scr_glibc_math.o", "/tmp/program.o"];
  expect(inputsWithoutLld("linux", inputs)).toEqual(["/pack/scr_lib.o", "/tmp/program.o"]);
  expect(inputsWithoutLld("darwin", inputs)).toEqual(inputs);
  expect(inputsWithoutLld("windows", inputs)).toEqual(inputs);
});
