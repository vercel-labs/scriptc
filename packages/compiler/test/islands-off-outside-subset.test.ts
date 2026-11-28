import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

function project(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-islands-off-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

function packageFiles(body: string): Record<string, string> {
  return {
    "node_modules/pkg/package.json":
      '{"name":"pkg","version":"1.0.0","type":"module","main":"./index.js","types":"./index.d.ts"}',
    "node_modules/pkg/index.d.ts": "export declare function tag(value: object): object;\n",
    "node_modules/pkg/index.js": body,
  };
}

const MAIN = 'import { tag } from "pkg";\nconsole.log(tag({ a: 1 }));\n';

test("islands off fails the build with SC8002 for a package outside the native subset", async () => {
  const dir = project({
    "package.json": '{"type":"module"}',
    // A pre-scan reason (R2.2 prototype mutation): this package cannot run
    // natively, and with islands off the build must say so instead of
    // emitting a program whose deferred fence throws when it runs.
    ...packageFiles(
      "export function tag(value) {\n  Object.setPrototypeOf(value, null);\n  return value;\n}\n",
    ),
    "main.ts": MAIN,
  });
  try {
    const result = await compile(join(dir, "main.ts"), {
      outDir: dir,
      outPath: join(dir, "main"),
      outputKind: "ir",
      nodeIslands: { mode: "off" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const sc8002 = result.diagnostics.filter((d) => d.code === "SC8002");
    expect(sc8002).toHaveLength(1);
    expect(sc8002[0]!.message).toContain("npm package 'pkg' is outside the native subset");
    expect(sc8002[0]!.message).toContain("Node islands are off");
    expect(sc8002[0]!.hint).toContain("--node-island=pkg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("islands off still builds a package inside the native subset", async () => {
  const dir = project({
    "package.json": '{"type":"module"}',
    ...packageFiles("export function tag(value) {\n  return value;\n}\n"),
    "main.ts": MAIN,
  });
  try {
    const result = await compile(join(dir, "main.ts"), {
      outDir: dir,
      outPath: join(dir, "main"),
      outputKind: "ir",
      nodeIslands: { mode: "off" },
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    expect(result.ok).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
