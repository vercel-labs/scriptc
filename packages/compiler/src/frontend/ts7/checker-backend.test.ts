import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { checkerBackend, tscTsExecutable, tscTsPlatformPackage } from "./checker-backend.js";

// The copy's name comes from randomBytes; `fixedRandom` makes it known. `writes`
// collects the mode of each file writeSync writes to. A directory in
// `unwritable` fails accessSync's write check, and `reads` collects the paths
// readFileSync reads.
const state = vi.hoisted(() => ({
  fixedRandom: false,
  writes: null as number[] | null,
  unwritable: new Set<string>(),
  reads: [] as string[],
}));
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return {
    ...crypto,
    randomBytes: (size: number) =>
      state.fixedRandom ? Buffer.alloc(size, 0xab) : crypto.randomBytes(size),
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    accessSync: ((path: string, mode?: number) => {
      if (mode !== undefined && (mode & fs.constants.W_OK) !== 0 && state.unwritable.has(path))
        throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
      return fs.accessSync(path, mode);
    }) as typeof fs.accessSync,
    readFileSync: ((path: string, ...rest: unknown[]) => {
      state.reads.push(String(path));
      return (fs.readFileSync as (path: string, ...rest: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      state.writes?.push(fs.fstatSync(fd).mode & 0o7777);
      return (fs.writeSync as (fd: number, ...rest: unknown[]) => number)(fd, ...rest);
    }) as typeof fs.writeSync,
  };
});

const roots: string[] = [];

afterEach(() => {
  state.fixedRandom = false;
  state.unwritable.clear();
  state.reads = [];
  state.writes = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptc-checker-")));
  roots.push(root);
  return root;
}

function writePackage(directory: string, name: string, executable?: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name }));
  if (executable === undefined) return;
  mkdirSync(join(directory, "lib"), { recursive: true });
  writeFileSync(join(directory, "lib", executable), "");
}

test("tsc-ts is the default checker, and SCRIPTC_CHECKER selects one", () => {
  expect(checkerBackend({})).toBe("tsc-ts");
  expect(checkerBackend({ SCRIPTC_CHECKER: "" })).toBe("tsc-ts");
  expect(checkerBackend({ SCRIPTC_CHECKER: "tsc-ts" })).toBe("tsc-ts");
  expect(checkerBackend({ SCRIPTC_CHECKER: "tsgo" })).toBe("tsgo");
  expect(() => checkerBackend({ SCRIPTC_CHECKER: "tsc" })).toThrow(
    'SCRIPTC_CHECKER must be tsgo or tsc-ts, not "tsc"',
  );
});

test("tsc-ts platform packages are named for the host", () => {
  expect(tscTsPlatformPackage("linux", "x64", false)).toBe("@tsc-ts/linux-x64-gnu");
  expect(tscTsPlatformPackage("linux", "arm64", true)).toBe("@tsc-ts/linux-arm64-musl");
  expect(tscTsPlatformPackage("darwin", "arm64", false)).toBe("@tsc-ts/darwin-arm64");
  expect(tscTsPlatformPackage("win32", "x64", false)).toBe("@tsc-ts/win32-x64-msvc");
});

test("the tsc-ts executable is found next to an npm install of tsc-ts", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  mkdirSync(join(root, "src/deep"), { recursive: true });
  expect(tscTsExecutable([join(root, "src/deep")], "@tsc-ts/linux-x64-gnu", "linux")).toBe(
    join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib/tsc-ts"),
  );
});

test("the tsc-ts executable is found in a pnpm install of tsc-ts", () => {
  const root = tempRoot();
  const store = join(root, "node_modules/.pnpm/tsc-ts@0.0.3/node_modules");
  writePackage(join(store, "tsc-ts"), "tsc-ts");
  writePackage(join(store, "@tsc-ts/win32-x64-msvc"), "@tsc-ts/win32-x64-msvc", "tsc-ts.exe");
  mkdirSync(join(root, "app/node_modules"), { recursive: true });
  symlinkSync(join(store, "tsc-ts"), join(root, "app/node_modules/tsc-ts"));
  expect(tscTsExecutable([join(root, "app")], "@tsc-ts/win32-x64-msvc", "win32")).toBe(
    join(store, "@tsc-ts/win32-x64-msvc/lib/tsc-ts.exe"),
  );
});

test("a missing tsc-ts install or platform package is an error", () => {
  const root = tempRoot();
  expect(() => tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux")).toThrow(
    "the tsc-ts package is not installed",
  );
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  expect(() => tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux")).toThrow(
    "has no @tsc-ts/linux-x64-gnu executable",
  );
});

test("a Linux tsc-ts executable is written again once, with one write", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  const lib = join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  const executable = join(lib, "tsc-ts");
  writeFileSync(executable, "the checker's bytes");
  chmodSync(executable, 0o755);
  const before = statSync(executable);
  expect(tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux")).toBe(executable);
  const after = statSync(executable);
  expect(after.ino).not.toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o755);
  expect(readFileSync(executable, "utf8")).toBe("the checker's bytes");
  expect(readFileSync(join(lib, ".tsc-ts-written"), "utf8")).toBe(String(after.size));
  // A later build finds the marker and leaves the copy as it is.
  tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux");
  expect(statSync(executable).ino).toBe(after.ino);
  expect(readdirSync(lib).sort()).toEqual([".tsc-ts-written", "tsc-ts"]);
});

test("the copy is created with mode 0600 and gets the executable's mode before the rename", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  const executable = join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib/tsc-ts");
  writeFileSync(executable, "the checker's bytes");
  chmodSync(executable, 0o755);
  state.writes = [];
  const umask = process.umask(0o002);
  try {
    tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux");
  } finally {
    process.umask(umask);
  }
  // The executable and the marker, each written while its file is 0600.
  expect(state.writes).toEqual([0o600, 0o600]);
  expect(statSync(executable).mode & 0o7777).toBe(0o755);
});

test("a path already at the copy's name is not followed", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  const lib = join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib");
  const executable = join(lib, "tsc-ts");
  const victim = join(root, "victim");
  writeFileSync(victim, "not the checker");
  const temporary = `${executable}.${"ab".repeat(8)}.tmp`;
  symlinkSync(victim, temporary);
  const before = statSync(executable);
  state.fixedRandom = true;
  expect(tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux")).toBe(executable);
  expect(readFileSync(victim, "utf8")).toBe("not the checker");
  expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
  expect(statSync(executable).ino).toBe(before.ino);
  expect(readdirSync(lib).sort()).toEqual(["tsc-ts", `tsc-ts.${"ab".repeat(8)}.tmp`]);
});

test("an executable in a directory this process cannot write is not read", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  const lib = join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib");
  const executable = join(lib, "tsc-ts");
  const before = statSync(executable);
  state.unwritable.add(lib);
  expect(tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux")).toBe(executable);
  expect(state.reads).not.toContain(executable);
  expect(statSync(executable).ino).toBe(before.ino);
  expect(readdirSync(lib)).toEqual(["tsc-ts"]);
});

test("each executable is checked once per process", () => {
  const root = tempRoot();
  writePackage(join(root, "node_modules/tsc-ts"), "tsc-ts");
  writePackage(join(root, "node_modules/@tsc-ts/linux-x64-gnu"), "@tsc-ts/linux-x64-gnu", "tsc-ts");
  const lib = join(root, "node_modules/@tsc-ts/linux-x64-gnu/lib");
  state.unwritable.add(lib);
  tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux");
  const marker = join(lib, ".tsc-ts-written");
  const firstReads = state.reads.filter((path) => path === marker).length;
  expect(firstReads).toBe(1);
  tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux");
  tscTsExecutable([root], "@tsc-ts/linux-x64-gnu", "linux");
  expect(state.reads.filter((path) => path === marker).length).toBe(1);
});
