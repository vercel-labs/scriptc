import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { checkerBackend, tscTsExecutable, tscTsPlatformPackage } from "./checker-backend.js";

const roots: string[] = [];

afterEach(() => {
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
