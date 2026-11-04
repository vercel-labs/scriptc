/* A runtime built with -DSCR_CYC_MAX_TYPES=<n> sizes the young-in nursery's
 * per-id skip countdown (scr_yin_skip) to n entries. The emitted program
 * declares the table without a size, so it links against such a runtime:
 * a program whose constructors enter the nursery inline compiles to LLVM,
 * links with the runtime sources built with SCR_YIN and a 16-entry registry,
 * and prints what Node prints. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";
import { EXECUTABLE_RUNTIME_SOURCES } from "../src/backend/native-toolchain.js";

const exec = promisify(execFile);
const runtimeDir = join(import.meta.dirname, "../../runtime/src");

const source = `class Ring {
  next: Ring | null = null;
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}
let total = 0;
for (let i = 0; i < 20000; i++) {
  const a = new Ring(i);
  const b = new Ring(1);
  a.next = b;
  b.next = a;
  total += a.value + (a.next === null ? 0 : a.next.value);
}
console.log(total);
`;

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "an emitted program links and runs against a runtime with a small cycle-type registry",
  { timeout: 600_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "scriptc-yin-registry-"));
    const saved = process.env["SCRIPTC_YOUNG_NURSERY"];
    try {
      const entry = join(dir, "main.ts");
      const ll = join(dir, "main.ll");
      await writeFile(entry, source);
      process.env["SCRIPTC_YOUNG_NURSERY"] = "1";
      const result = await compile(entry, { outDir: dir, outPath: ll, outputKind: "llvm" });
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      const text = await readFile(ll, "utf8");
      expect(text).toContain("@scr_yin_skip = external global [0 x i32]");
      expect(text).toContain("getelementptr inbounds i32, ptr @scr_yin_skip, i64 %ye.id");

      const bin = join(dir, "main");
      await exec("clang", [
        "-O1",
        "-w",
        "-pthread",
        "-D_GNU_SOURCE",
        "-DSCR_YIN",
        "-DSCR_CYC_MAX_TYPES=16",
        ll,
        ...EXECUTABLE_RUNTIME_SOURCES.map((name) => join(runtimeDir, name)),
        "-lm",
        "-o",
        bin,
      ]);
      const run = await exec(bin, []);
      expect(run.stdout).toBe("200010000\n");
    } finally {
      if (saved === undefined) delete process.env["SCRIPTC_YOUNG_NURSERY"];
      else process.env["SCRIPTC_YOUNG_NURSERY"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
