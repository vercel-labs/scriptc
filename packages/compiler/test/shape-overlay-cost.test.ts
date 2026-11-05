/* The overlay's compile-cost pieces: the memo that carries a build's
 * verdicts to the next build of the same JavaScript (memo.ts), and method
 * families that join only the methods a call can reach together
 * (overlay.ts), so a call on one class keeps that class's result type. */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";
import {
  overlayMemoKey,
  readOverlayMemo,
  setShapeOverlayMemoDir,
  writeOverlayMemo,
} from "../src/frontend/shape-inference/memo.js";

const packageSource = `export class Str {
  constructor(checks) { this.checks = checks; }
  _addCheck(c) { return new Str([...this.checks, c]); }
  min(n) { return this._addCheck({ kind: "min", n }); }
  max(n) { return this._addCheck({ kind: "max", n }); }
}
export class Num {
  constructor(checks) { this.checks = checks; }
  _addCheck(c) { return new Num([...this.checks, c]); }
  int() { return this._addCheck({ kind: "int" }); }
}
export const str = () => new Str([]);
export const num = () => new Num([]);
`;

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-overlay-cost-"));
  const pkg = join(dir, "node_modules/families-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "families-fixture",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "families-fixture": "1.0.0" } }),
  );
  await writeFile(
    join(dir, "main.ts"),
    `import { str, num } from "families-fixture";\n` +
      `console.log(str().min(1).max(2).checks.length, num().int().checks.length);\n`,
  );
  for (const k of ["SCRIPTC_SHAPE_OVERLAY", "SCRIPTC_DEBUG_SHAPE_OVERLAY", "SCRIPTC_NO_CACHE"])
    saved[k] = process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setShapeOverlayMemoDir(null);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

test("same-named methods no call reaches together keep their own result types", async () => {
  process.env["SCRIPTC_SHAPE_OVERLAY"] = "1";
  process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] = "1";
  process.env["SCRIPTC_NO_CACHE"] = "1";
  let text = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  const result = await compile(join(dir, "main.ts"), {
    outDir: dir,
    outPath: join(dir, "main.ir.json"),
    outputKind: "ir",
    npmStatic: ["families-fixture"],
  });
  vi.restoreAllMocks();
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  expect(text).toMatch(/@returns \{Str\}[^\n]*\*\/ _addCheck\(c\) \{ return new Str/);
  expect(text).toMatch(/@returns \{Num\}[^\n]*\*\/ _addCheck\(c\) \{ return new Num/);
  expect(text).not.toContain("Str | Num");
});

test("a memo round-trips and is keyed by every JavaScript file's text", async () => {
  const memoDir = join(dir, "memo");
  setShapeOverlayMemoDir(memoDir);
  const key = overlayMemoKey([
    ["/p/a.js", "a"],
    ["/p/b.js", "b"],
  ]);
  expect(
    overlayMemoKey([
      ["/p/b.js", "b"],
      ["/p/a.js", "a"],
    ]),
  ).toBe(key);
  expect(
    overlayMemoKey([
      ["/p/a.js", "a"],
      ["/p/b.js", "b2"],
    ]),
  ).not.toBe(key);
  expect(readOverlayMemo(key)).toBeNull();
  const memo = {
    off: false,
    annotations: [{ file: "/p/a.js", hash: "h", ids: [3, 7] }],
    files: [],
    plainFences: ["SC2002|/p/a.js|4"],
  };
  writeOverlayMemo(key, memo);
  expect(readOverlayMemo(key)).toEqual(memo);
  expect((await readdir(memoDir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  // A malformed memo reads as none.
  await writeFile(join(memoDir, `${key}.json`), `{"off": 1}`);
  expect(readOverlayMemo(key)).toBeNull();
  // Without a memo directory (SCRIPTC_NO_CACHE) nothing is read or written.
  setShapeOverlayMemoDir(null);
  expect(readOverlayMemo(key)).toBeNull();
});
