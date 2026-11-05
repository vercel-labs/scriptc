/* A declaration a project type patch edited keeps the patch alone: the
 * shape overlay writes no annotation on it (overlay.ts
 * setShapeOverlayProtectedSpans; the type-patches layer supplies the
 * spans). Other declarations of the same file are typed as usual. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { compile } from "../src/index.js";
import { setShapeOverlayProtectedSpans } from "../src/frontend/shape-inference/index.js";

const patchedDoc = "/** @param {number} n patched by the project */";
const packageSource = `export function twice(n) { return n * 2; }
${patchedDoc}
export function thrice(n) { return n * 3; }
`;

let dir = "";
const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scriptc-overlay-patch-"));
  const pkg = join(dir, "node_modules/patched-fixture");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "patched-fixture", version: "1.0.0", type: "module", main: "index.js" }),
  );
  await writeFile(join(pkg, "index.js"), packageSource);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", dependencies: { "patched-fixture": "1.0.0" } }),
  );
  await writeFile(
    join(dir, "main.ts"),
    `import { twice, thrice } from "patched-fixture";\nconsole.log(twice(2), thrice(3));\n`,
  );
  for (const k of ["SCRIPTC_SHAPE_OVERLAY", "SCRIPTC_DEBUG_SHAPE_OVERLAY", "SCRIPTC_NO_CACHE"])
    saved[k] = process.env[k];
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setShapeOverlayProtectedSpans(null);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function overlayText(): Promise<string> {
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
    npmStatic: ["patched-fixture"],
  });
  vi.restoreAllMocks();
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  const start = text.indexOf("[shape-overlay] ");
  return start < 0 ? "" : text.slice(start);
}

test("the overlay types both functions without a patch", async () => {
  const text = await overlayText();
  expect(text).toMatch(/@scriptcShape #\d+ \*\/ export function twice/);
  expect(text).toMatch(/@scriptcShape #\d+ \*\/ export function thrice/);
});

test("a patched declaration gets no overlay annotation", async () => {
  const start = packageSource.indexOf(patchedDoc);
  setShapeOverlayProtectedSpans((file) =>
    file.endsWith("patched-fixture/index.js") ? [{ start, end: start + patchedDoc.length }] : [],
  );
  const text = await overlayText();
  expect(text).toMatch(/@scriptcShape #\d+ \*\/ export function twice/);
  expect(text).toContain(`${patchedDoc}\nexport function thrice`);
  expect(text).not.toMatch(/@scriptcShape #\d+ \*\/ export function thrice/);
});
