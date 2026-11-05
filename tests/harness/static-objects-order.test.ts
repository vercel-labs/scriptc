/* Static-object specialization (shape-inference/static-objects.ts): the
 * rewrites keep what the program evaluates and when its modules load. With
 * the shape overlay on, the npm case static-objects-order (through its
 * JavaScript consumer, js-main.cjs) keeps receivers with effects as
 * written, keeps reads that may run before what they read exists, binds a
 * module where the program loads it and only for reads that run after the
 * binding, never adds a hoisted class to an exports literal that runs
 * before the class's declaration, does not fold a literal's `__proto__`,
 * keeps constructors whose methods store from for-in and for-of heads where
 * strict mode throws, and prints what Node prints. A module in a require cycle through another
 * module is not read through its exports from the cycle. The rewritten
 * files are read from the overlay's debug output
 * (SCRIPTC_DEBUG_SHAPE_OVERLAY). */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** Compiles `entry` with the overlay on; the result and the debug output. */
async function compileWithOverlay(entry: string, name: string) {
  const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests", name);
  mkdirSync(outDir, { recursive: true });
  // The debug output comes from the frontend, which a cached build skips.
  const saved = process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"];
  const savedCache = process.env["SCRIPTC_NO_CACHE"];
  process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] = "1";
  process.env["SCRIPTC_NO_CACHE"] = "1";
  let debug = "";
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    debug += String(chunk);
    return true;
  });
  try {
    const result = await compile(entry, {
      outPath: join(outDir, "main"),
      outDir,
      sanitize,
      shapeOverlay: true,
    });
    return { result, debug };
  } finally {
    write.mockRestore();
    if (saved === undefined) delete process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"];
    else process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY"] = saved;
    if (savedCache === undefined) delete process.env["SCRIPTC_NO_CACHE"];
    else process.env["SCRIPTC_NO_CACHE"] = savedCache;
  }
}

/** The text the rewrites give `file` in the debug output, if any. */
function rewrittenIfAny(debug: string, file: string): string | undefined {
  const parts = debug.split(/^\[(?:static-objects|shape-overlay)\] /m);
  return parts.find((p) => p.startsWith(`${file}\n`))?.slice(file.length + 1);
}

/** The text the rewrites give `file` in the debug output. */
function rewritten(debug: string, file: string): string {
  const text = rewrittenIfAny(debug, file);
  expect(text, `no rewrite of ${file}`).toBeDefined();
  return text!;
}

test(
  "receivers with effects, and exports literals before a class, stay as written",
  { timeout: 600_000 },
  async () => {
    const entry = join(repoRoot, "tests/fixtures/npm/cases/static-objects-order/js-main.cjs");
    const { result, debug } = await compileWithOverlay(entry, "static-objects-order");
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const pkg = join(dirname(entry), "node_modules/static-objects-order");
    expect(debug).toContain(
      "kept constant read (reads++, ns.Kind).A: the receiver may have effects",
    );
    expect(debug).toContain(
      "kept reference (reads++, ns.util).twice: the receiver may have effects",
    );
    expect(debug).toContain(
      "kept table call (reads++, ns.ops)[op]: the table expression may have effects",
    );
    // vec.js assigns its exports literal before the constructor function.
    // receivers.js reads ns.Late.X and calls ns.later() before they exist.
    expect(debug).toContain(
      "kept constant read ns.Late.X: it may run before the object is created",
    );
    expect(debug).toContain("kept reference ns.later: it may run before the member is stored");
    // lazy-user.js's first mention of lazy.js is a conditional require: the
    // binding follows the statement that loads the module each time it runs.
    expect(rewritten(debug, join(pkg, "lazy-user.js"))).toMatch(
      /var m = require\("\.\/lazy"\);\nconst __ns_mod_\w+ = require\("\.\/lazy"\);/,
    );
    // early-user.js calls a function in the statement that loads lazy.js:
    // a binding after that statement is not initialized when it runs.
    expect(rewrittenIfAny(debug, join(pkg, "early-user.js")) ?? "").not.toContain("__ns_mod_");
    // coerce.js converts an object with a toString method between its
    // constructor and the method: the conversion runs before the method exists.
    expect(debug).toContain("code runs between the constructor and its methods");
    expect(rewrittenIfAny(debug, join(pkg, "coerce.js")) ?? "").not.toContain(
      "class __ns_shapes_Box",
    );
    // loops.js's methods store from for-in and for-of heads into the
    // read-only global `undefined` and into a property of a string, which
    // throws in a class body.
    const loops = rewrittenIfAny(debug, join(pkg, "loops.js")) ?? "";
    expect(loops).not.toContain("class __ns_shapes_Bag");
    expect(loops).not.toContain("class __ns_shapes_Cell");
    const vec = rewritten(debug, join(pkg, "vec.js"));
    expect(vec).toContain("class __ns_geo_Vec");
    expect(vec).toContain("module.exports = { geo: geo };");
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const node = await execFileAsync(process.execPath, [entry], {
      cwd: dirname(entry),
      encoding: "utf8",
    });
    expect(stdout).toBe(node.stdout);
  },
);

test(
  "a module in a require cycle is not read through its exports",
  { timeout: 600_000 },
  async () => {
    // cycle-pkg's cycle-d.js requires cycle-m.js, which requires cycle-r.js, which reads
    // cycle-d's namespace while cycle-d is still loading. scriptc refuses the
    // cycle itself (SC1016); the rewrite must not change what cycle-r reads.
    const entry = join(repoRoot, "tests/fixtures/static-objects-cycle/main.cjs");
    const { debug } = await compileWithOverlay(entry, "static-objects-cycle");
    const text = rewritten(debug, join(dirname(entry), "node_modules/cycle-pkg/cycle-r.js"));
    expect(text).toContain("typeof d.dd.f");
    expect(text).not.toContain("__ns_mod_");
  },
);
