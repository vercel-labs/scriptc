import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RECORD_PROFILE_BLOCKS_ENV, profileBlocksPath } from "../backend/native-profile.js";
import { LINUX_X64_GNU_TARGET } from "../backend/targets.js";
import { NativeCache } from "./cache.js";
import {
  readUnchangedBuild,
  recordUnchangedBuild,
  unchangedBuildKey,
  type UnchangedBuildInputs,
} from "./unchanged.js";
import type { NativeToolchain } from "./toolchain.js";

const probes = { version: 1 as const, stable: true, probes: [] };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A directory the test removes afterwards. */
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-native-unchanged-"));
  roots.push(root);
  return root;
}

/** The records of a build that wrote an executable, its LLVM text and the
 * files beside them. */
function build(directory: string, beside: string[], packInputs: string[] = []) {
  const output = join(directory, "program");
  writeFileSync(output, "executable");
  const translationUnitPath = join(directory, "entry.ll");
  writeFileSync(translationUnitPath, "; llvm");
  const cache = new NativeCache(join(directory, "cache"));
  recordUnchangedBuild(
    cache,
    "key",
    {},
    {
      probes,
      output,
      translationUnitPath,
      irPath: null,
      beside,
      packInputs,
    },
  );
  return { cache, output, translationUnitPath };
}

test("a rewritten file inside a .dSYM bundle is not the recorded one", () => {
  const directory = temporary();
  const bundle = join(directory, "program.dSYM");
  const dwarf = join(bundle, "Contents/Resources/DWARF/program");
  mkdirSync(join(bundle, "Contents/Resources/DWARF"), { recursive: true });
  writeFileSync(dwarf, "first symbols");
  const { cache } = build(directory, [bundle]);
  expect(readUnchangedBuild(cache, "key", {})).not.toBeNull();
  // A tool that edits the debug information rewrites the DWARF file in
  // place: the bundle directory's own identity does not change.
  const time = statSync(dwarf).mtime;
  writeFileSync(dwarf, "other symbols");
  utimesSync(dwarf, time, time);
  expect(readUnchangedBuild(cache, "key", {})).toBeNull();
});

test("a removed file in a .dSYM bundle is not the recorded one", () => {
  const directory = temporary();
  const bundle = join(directory, "program.dSYM");
  const dwarf = join(bundle, "Contents/Resources/DWARF/program");
  mkdirSync(join(bundle, "Contents/Resources/DWARF"), { recursive: true });
  writeFileSync(dwarf, "symbols");
  const { cache } = build(directory, [bundle]);
  expect(readUnchangedBuild(cache, "key", {})).not.toBeNull();
  rmSync(dwarf);
  expect(readUnchangedBuild(cache, "key", {})).toBeNull();
});

test("a runtime pack artifact replaced in place is not the one the build linked", () => {
  const directory = temporary();
  const archive = join(directory, "libruntime.a");
  writeFileSync(archive, "first archive");
  const { cache } = build(directory, [], [archive]);
  expect(readUnchangedBuild(cache, "key", {})).not.toBeNull();
  // Same size, same modification time: only the file's other fields tell it
  // was written again.
  const time = statSync(archive).mtime;
  writeFileSync(archive, "other archive");
  utimesSync(archive, time, time);
  expect(readUnchangedBuild(cache, "key", {})).toBeNull();
});

function toolchain(directory: string): NativeToolchain {
  const tool = (name: string): string => {
    const path = join(directory, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };
  const helperPackageRoot = join(directory, "helper");
  mkdirSync(helperPackageRoot);
  writeFileSync(join(helperPackageRoot, "package.json"), '{"name":"helper","version":"0.0.0"}');
  const runtimePackRoot = join(directory, "pack");
  mkdirSync(runtimePackRoot);
  writeFileSync(join(runtimePackRoot, "package.json"), '{"name":"pack","version":"0.0.0"}');
  return {
    compilerVersion: "0.0.0",
    target: LINUX_X64_GNU_TARGET,
    helper: LINUX_X64_GNU_TARGET.helper,
    ts7Executable: tool("ts7"),
    helperExecutable: tool("codegen"),
    helperPackageRoot,
    runtimePackRoot,
    linker: tool("clang"),
    linkerArgs: [],
    dsymutil: tool("dsymutil"),
  };
}

/** A profile build's inputs, in a directory of their own. */
function profileBuild(): UnchangedBuildInputs {
  const directory = temporary();
  const entry = join(directory, "entry.ts");
  writeFileSync(entry, "export const value = 1;\n");
  const profileUse = join(directory, "app.profdata");
  writeFileSync(profileUse, "indexed profile");
  return {
    entry,
    options: {
      outDir: directory,
      outPath: join(directory, "program"),
      backend: "llvm",
      optimization: "speed",
      profileUse,
    },
    ffi: null,
    ffiBytes: null,
    toolchain: toolchain(directory),
    output: join(directory, "program"),
    translationUnitPath: join(directory, "entry.ll"),
  };
}

test.skipIf(process.platform === "win32")(
  "a changed block-count file beside a profile is another build",
  () => {
    const inputs = profileBuild();
    const withoutBlocks = unchangedBuildKey(inputs);
    expect(withoutBlocks).not.toBeNull();
    const blocks = profileBlocksPath(inputs.options.profileUse!);
    writeFileSync(blocks, "first counts");
    const withBlocks = unchangedBuildKey(inputs);
    expect(withBlocks).not.toBe(withoutBlocks);
    writeFileSync(blocks, "other counts");
    expect(unchangedBuildKey(inputs)).not.toBe(withBlocks);
  },
);

test.skipIf(process.platform === "win32")(
  "a build that writes block counts keeps nothing for a later build",
  () => {
    const inputs = profileBuild();
    expect(unchangedBuildKey(inputs)).not.toBeNull();
    const recorded = process.env[RECORD_PROFILE_BLOCKS_ENV];
    try {
      process.env[RECORD_PROFILE_BLOCKS_ENV] = join(dirname(inputs.output), "counts.txt");
      // A kept output never runs the helper, and the helper is what writes
      // the file the build asked for.
      expect(unchangedBuildKey(inputs)).toBeNull();
    } finally {
      if (recorded === undefined) delete process.env[RECORD_PROFILE_BLOCKS_ENV];
      else process.env[RECORD_PROFILE_BLOCKS_ENV] = recorded;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a sanitized build keeps nothing: its runtime is compiled from sources the key does not name",
  () => {
    const inputs = profileBuild();
    expect(unchangedBuildKey(inputs)).not.toBeNull();
    expect(
      unchangedBuildKey({ ...inputs, options: { ...inputs.options, sanitize: true } }),
    ).toBeNull();
  },
);
