import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { packageOfFile, realpathOf, type PackageScopeCache } from "./packages.js";

const directories: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-units-pkg-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("files in different subdirectories of one package share its root and keep their paths", () => {
  const root = tempRoot();
  const pkg = join(root, "pkg");
  write(join(pkg, "package.json"), JSON.stringify({ name: "pkg", version: "1.2.3" }));
  write(join(pkg, "src", "a.ts"), "export const a = 1;\n");
  write(join(pkg, "src", "c.ts"), "export const c = 1;\n");
  write(join(pkg, "lib", "deep", "b.ts"), "export const b = 1;\n");

  const cache: PackageScopeCache = new Map();
  // The cached walk after the first file must still answer the package's own
  // root, not the file's subdirectory.
  const a = packageOfFile(join(pkg, "src", "a.ts"), root, cache);
  const c = packageOfFile(join(pkg, "src", "c.ts"), root, cache);
  const b = packageOfFile(join(pkg, "lib", "deep", "b.ts"), root, cache);
  expect(a.name).toBe("pkg");
  expect(a.version).toBe("1.2.3");
  expect(a.root).toBe(realpathOf(pkg));
  expect(c.root).toBe(a.root);
  expect(b.root).toBe(a.root);
  expect(a.relative).toBe("src/a.ts");
  expect(c.relative).toBe("src/c.ts");
  expect(b.relative).toBe("lib/deep/b.ts");
});

test("a directory below one package resolves to that package, not a nested one", () => {
  const root = tempRoot();
  const outer = join(root, "outer");
  const inner = join(outer, "inner");
  write(join(outer, "package.json"), JSON.stringify({ name: "outer", version: "1.0.0" }));
  write(join(inner, "package.json"), JSON.stringify({ name: "inner", version: "2.0.0" }));
  write(join(inner, "deep", "f.ts"), "export const f = 1;\n");
  const scope = packageOfFile(join(inner, "deep", "f.ts"), root);
  expect(scope.name).toBe("inner");
  expect(scope.relative).toBe("deep/f.ts");
});
