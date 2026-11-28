/* Island code constructs a class the program passes in: the host registers
 * every boxed class value with the island runtime (method table + a
 * constructor helper), so `new C(...)` inside the island builds the
 * program's instance exactly as Node does. Needs a libnode pack in
 * SCRIPTC_LIBNODE (libnode.ts), which is required in the Linux x64 lanes. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";
import { libnodePack } from "./libnode.js";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";
const pack = libnodePack();
const skip = pack === null;

const program = `"use strict";
const { make } = require("island-ctor-pkg");
class A {
  constructor(n) {
    this.v = n;
  }
}
const a = make(A);
console.log("made", a.v, a instanceof A);
`;

const packageMain = `"use strict";
// A computed require keeps this package outside the native subset, so it
// runs in a Node island.
const name = "./impl.cjs";
const impl = require(name);
exports.make = function (C) {
  return impl.build(C);
};
`;

const packageImpl = `"use strict";
exports.build = function (C) {
  return new C(7);
};
`;

let dir = "";

beforeAll(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "scriptc-island-class-construct-"));
  mkdirSync(join(dir, "node_modules/island-ctor-pkg"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"commonjs"}\n');
  writeFileSync(join(dir, "main.js"), program);
  writeFileSync(
    join(dir, "node_modules/island-ctor-pkg/package.json"),
    '{"name":"island-ctor-pkg","version":"1.0.0","main":"index.js"}\n',
  );
  writeFileSync(join(dir, "node_modules/island-ctor-pkg/index.js"), packageMain);
  writeFileSync(join(dir, "node_modules/island-ctor-pkg/impl.cjs"), packageImpl);
});

describe("island code constructs a class the program passes in", () => {
  test.skipIf(skip)("matches Node", async () => {
    const node = await execFileAsync(process.execPath, [join(dir, "main.js")], {
      encoding: "utf8",
      cwd: dir,
    });
    const result = await compile(join(dir, "main.js"), {
      outDir: join(dir, "out"),
      outPath: join(dir, "out/main"),
      sanitize,
      libnode: pack!,
    });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const native = await execFileAsync(result.binaryPath, [], { encoding: "utf8", cwd: dir });
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toBe("made 7 true\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
