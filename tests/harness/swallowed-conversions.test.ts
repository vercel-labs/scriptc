/* SC6009 against Node: a checked conversion of unverified data whose
 * failure ends in a handler that neither reads the error nor throws.
 *
 * The fixture gives every function well-formed data that lacks a member
 * the type declares. Node.js checks nothing and keeps each value. Natively
 * the conversion throws, and the functions the warning names silently take
 * their handler's path. The test pins that the build warns at exactly those
 * conversions, that the binary differs from Node at exactly those
 * functions, and that the other functions say what failed. The warning
 * itself changes nothing: the binary is the one a build without it makes.
 *
 * SCRIPTC_SAN=1 builds this with ASan + the RC audit like every harness lane.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const fixture = join(repoRoot, "tests/coverage-fixtures/swallowed-conversions.ts");

test(
  `the functions SC6009 names differ from Node, silently${sanitize ? " (sanitized)" : ""}`,
  { timeout: 300_000 },
  async () => {
    const outDir = join(
      repoRoot,
      "node_modules/.cache/scriptc-tests",
      `swallowed-conversions-${sanitize ? "san" : "plain"}`,
    );
    mkdirSync(outDir, { recursive: true });
    const result = await compile(fixture, {
      outPath: join(outDir, "swallowed"),
      outDir,
      sanitize,
      backend: "llvm",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));

    // One warning per conversion a handler swallows, at the conversion.
    const source = readFileSync(fixture, "utf8");
    const lineOf = (offset: number): string =>
      source.split("\n")[source.slice(0, offset).split("\n").length - 1]!.trim();
    const warned = (result.warnings ?? []).filter((d) => d.code === "SC6009");
    expect(
      warned.map((d) => [
        lineOf(d.loc.start),
        /is caught by|rejects a promise|is discarded by/.exec(d.message)?.[0],
      ]),
    ).toEqual([
      ["return JSON.parse(text) as Entry;", "is caught by"], // bare
      ["entry = JSON.parse(text) as Entry;", "is discarded by"], // discarded
      ["return JSON.parse(text) as Entry;", "is caught by"], // decode, through called
      [".then((t) => JSON.parse(t) as Entry)", "rejects a promise"], // chained
    ]);
    expect(warned[2]!.message).toContain("reached through the call at swallowed-conversions.ts:");

    const node = await execFileAsync(process.execPath, [fixture], { encoding: "utf8" });
    expect(node.stdout).toBe(
      [
        "bare kept",
        "seen kept",
        "rethrown kept",
        "discarded kept",
        "called kept",
        "chained kept",
        "chainedSeen kept",
        "reported 0",
        "",
      ].join("\n"),
    );
    const native = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    // The four warned functions drop the value and report nothing. The
    // three others each report the TypeError.
    expect(native.stdout).toBe(
      [
        "bare dropped",
        "seen dropped",
        "rethrown threw",
        "discarded dropped",
        "called dropped",
        "chained dropped",
        "chainedSeen dropped",
        "reported 3",
        "",
      ].join("\n"),
    );
    expect(native.stderr.replace(/^==\d+==WARNING: ASan.*\n/gm, "")).toBe("");
  },
);
