import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { packageDirectorySources, packageOfFile } from "./packages.js";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "scriptc-units-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a package's file set is every implementation source it holds, sorted", () => {
  const root = tree({
    "package.json": JSON.stringify({ name: "lib", version: "1.2.3" }),
    "index.ts": "export const a = 1;\n",
    "src/b.js": "export const b = 2;\n",
    "src/types.d.ts": "export declare const c: number;\n",
    "src/note.md": "# not source\n",
    "node_modules/dep/index.js": "export {};\n",
    ".git/objects": "x",
  });
  const files = packageDirectorySources(root);
  expect(files.map((file) => file.relative)).toEqual(["index.ts", "src/b.js"]);
  // Each entry is content-addressed: a digest of the file's bytes.
  expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.digest))).toBe(true);
  expect(files[0]!.digest).not.toBe(files[1]!.digest);
});

test("a vendored copy's own package.json names its unit, not the app's", () => {
  // native-sdk copies npm dependencies under the app's `.native` directory.
  // When the copy keeps its package.json, the nearest named scope is the
  // copy's: the package is its own unit, not part of the app.
  const app = tree({
    "package.json": JSON.stringify({ name: "example-todo", version: "0.0.0" }),
    ".native/preact/package.json": JSON.stringify({ name: "preact", version: "10.19.3" }),
    ".native/preact/src/index.js": "export {};\n",
    ".native/src/app.ts": "export {};\n",
  });
  const vendored = packageOfFile(join(app, ".native/preact/src/index.js"), app);
  expect(vendored.name).toBe("preact");
  expect(vendored.version).toBe("10.19.3");
  expect(vendored.relative).toBe("src/index.js");
  const own = packageOfFile(join(app, ".native/src/app.ts"), app);
  expect(own.name).toBe("example-todo");
});
