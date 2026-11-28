/* A class field keyed by a CommonJS module's exported symbol
 * (`exports.SYM = Symbol("…")`, then `this[exports.SYM] = v`): the key is
 * one identity for the module's evaluation and the export's global holds
 * the value, so the field takes an ordinary hidden slot of the static
 * layout. Compiled with Node islands off, the package is compiled
 * statically; the binary must print what Node does. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const packageMain = `"use strict";
exports.SYM = Symbol("sym");
class Holder {
  constructor(v) {
    this[exports.SYM] = v;
  }
  read() {
    return this[exports.SYM];
  }
}
exports.Holder = Holder;
`;

const program = `import { Holder } from "sym-pkg";

const holder = new Holder(5);
console.log("ok", holder.read());
`;

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scriptc-exported-symbol-"));
  mkdirSync(join(dir, "node_modules/sym-pkg"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "main.ts"), program);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", strict: true, skipLibCheck: true } }),
  );
  writeFileSync(
    join(dir, "node_modules/sym-pkg/package.json"),
    '{"name":"sym-pkg","version":"1.0.0","main":"index.js","types":"index.d.ts"}\n',
  );
  writeFileSync(join(dir, "node_modules/sym-pkg/index.js"), packageMain);
  writeFileSync(
    join(dir, "node_modules/sym-pkg/index.d.ts"),
    "export declare const SYM: unique symbol;\nexport declare class Holder {\n  constructor(v: number);\n  read(): number;\n}\n",
  );
});

describe("a field keyed by a module's exported symbol", () => {
  test("compiles statically and reads back what Node reads", async () => {
    const result = await compile(join(dir, "main.ts"), {
      outDir: join(dir, "out"),
      outPath: join(dir, "out/main"),
      sanitize,
      nodeIslands: "off",
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const native = await execFileAsync(result.binaryPath, [], { encoding: "utf8", cwd: dir });
    expect(native.stdout).toBe("ok 5\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
