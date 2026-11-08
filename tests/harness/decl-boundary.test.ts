/* The declaration-typed boundary's checks (decl-projection.ts): a value
 * zod's declarations type wrongly fails the boundary cast with a TypeError
 * naming the path, and a value the native record cannot represent (a
 * frozen object, a read-only key, an accessor, a non-enumerable key of an
 * index-signature record) fails with the reason, while a non-enumerable key
 * of a declared-field record crosses. Node does not check, so this is a
 * native-only test; npm.test.ts runs the differential cases
 * (zod3-boundary, zod3-adoption, zod3-infer, zod4-boundary,
 * hono-zod-validator). The hono test checks that `c.req.valid()` is such a
 * boundary under zod 4 and @hono/zod-validator. The rewrite test checks that
 * a file keeps its projection (no SC6102 note) where the rewrite has to
 * parenthesize a bare async arrow's parameter and cast the start of an
 * unbraced loop body. The undefined test is a declared type of exactly
 * `undefined` (a result type computed from a table whose type the program
 * built at run time): the cast passes for a value that is undefined and
 * throws for any other. The overload test checks that a call selecting one of
 * several declared signatures is checked against that signature's result,
 * and that the failure names the declaration. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const entry = join(repoRoot, "tests/fixtures/npm/cases/zod3-boundary/lying.ts");
const outDir = join(repoRoot, "node_modules/.cache/scriptc-tests/decl-boundary");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

test(
  "boundary casts throw a path TypeError for values the declarations misdescribe",
  { timeout: 600_000 },
  async () => {
    mkdirSync(outDir, { recursive: true });
    const result = await compile(entry, { outPath: join(outDir, "lying"), outDir, sanitize });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(entry), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    expect(stdout).toBe(
      "liar threw true expected number at $.n, got string\n" +
        "frozen threw expected a plain object (this value is frozen, sealed or not extensible) at $, got object\n" +
        'hidden a n {"n":1}\n' +
        "read-only threw expected a plain object (this value has read-only or non-configurable properties) at $, got object\n" +
        "accessor threw expected a plain object (this value has accessor properties) at $, got object\n" +
        "index threw expected a plain object (this value has a non-enumerable key its record type cannot keep) at $, got object\n",
    );
  },
);

test(
  "boundary rewrites keep bare async arrows and unbraced loop bodies valid",
  { timeout: 600_000 },
  async () => {
    const rewrites = join(repoRoot, "tests/fixtures/npm/cases/zod3-boundary/rewrites.ts");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(rewrites, {
      outPath: join(outDir, "rewrites"),
      outDir,
      sanitize,
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    // The file keeps its projection: no SC6102 note drops it (a build
    // that lowered nothing carries no warnings at all).
    expect((result.warnings ?? []).map((w) => w.code)).not.toContain("SC6102");
    const pending = execFileAsync(result.binaryPath, [], {
      cwd: dirname(rewrites),
      encoding: "utf8",
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    // Node's output: every loop iteration runs the cast statement.
    expect(stdout).toBe("loops 5\nasync arrow 4\n");
  },
);

test(
  "c.req.valid() is a checked boundary typed by the zod 4 schema",
  { timeout: 900_000 },
  async () => {
    const lying = join(repoRoot, "tests/fixtures/npm/cases/hono-zod-validator/lying.ts");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(lying, { outPath: join(outDir, "hono-lying"), outDir, sanitize });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    expect((result.warnings ?? []).map((w) => w.code)).not.toContain("SC6102");
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(lying), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    // Node prints "/liar 200 x1": it does not check the declared type.
    expect(stdout).toBe(
      "/liar 200 2\n" +
        "/liar 500 true expected number at $.n, got string\n" +
        "/outcome 200 value 42\n" +
        "/outcome 200 reason late\n",
    );
  },
);

test(
  "a boundary cast to a declared type of exactly undefined throws for a value that is not",
  { timeout: 600_000 },
  async () => {
    const lying = join(repoRoot, "tests/fixtures/npm/cases/decl-undefined-field/lying.ts");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(lying, {
      outPath: join(outDir, "undefined-lying"),
      outDir,
      sanitize,
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const pending = execFileAsync(result.binaryPath, [], { cwd: dirname(lying), encoding: "utf8" });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    // Node prints "absent none", "compared mira", "tested sited",
    // "asserted mira": it does not check the declared type.
    expect(stdout).toBe(
      "absent none\n" +
        "compared threw TypeError expected null | undefined at $, got string\n" +
        "tested threw TypeError expected null | undefined at $, got string\n" +
        "asserted threw TypeError expected null | undefined at $, got string\n",
    );
  },
);

test(
  "a call that selects a declared signature is checked against its result",
  { timeout: 600_000 },
  async () => {
    const claims = join(repoRoot, "tests/corpus/9562-npm-overload-selected-result/claims.ts");
    mkdirSync(outDir, { recursive: true });
    const result = await compile(claims, {
      outPath: join(outDir, "overload-claims"),
      outDir,
      sanitize,
    });
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const pending = execFileAsync(result.binaryPath, [], {
      cwd: dirname(claims),
      encoding: "utf8",
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    // Node prints "stored undefined", "arithmetic NaN", "method NaN" and its
    // own TypeErrors for the array and the record: it does not check.
    const held =
      "undefined is not representable in the target union (a value narrowed or asserted past it still held it)";
    const patch = (pkg: string, selector: string): string =>
      `    if that declaration is wrong, patch it: scriptc types patch ${pkg} '${selector}' '| undefined'\n`;
    expect(stdout).toBe(
      `stored threw true ${held}\n` +
        "    weigh@1.4.0 declares weigh() as number (index.d.ts:1)\n" +
        patch("weigh", "weigh()") +
        `arithmetic threw true ${held}\n` +
        "    gauge@2.1.0 declares read() as number (index.d.ts:1)\n" +
        patch("gauge", "read()") +
        `method threw true ${held}\n` +
        `array threw true ${held}\n` +
        "    gauge@2.1.0 declares spans() as number[] (index.d.ts:6)\n" +
        patch("gauge", "spans()") +
        `record threw true ${held}\n` +
        "    gauge@2.1.0 declares measured() as { mm: number; text: string; } (index.d.ts:8)\n" +
        patch("gauge", "measured()") +
        "honest 2010\n",
    );
  },
);
