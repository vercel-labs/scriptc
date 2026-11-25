import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

// An element of an optional-element array literal that comes from an
// untyped value is a checked-dynamic element: undefined is part of the
// array's element type, so the check admits it and the store keeps it as
// a present element. A value the check rejects names the element's
// position in the failure path.
test("an untyped element of an optional-element array literal keeps its undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-optional-element-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
function nums(value: any): Array<number | undefined> {
  return [value, 1];
}
function names(value: any): Array<string | undefined> {
  return [value, "a"];
}
function flags(value: any): Array<boolean | undefined> {
  return [value, true];
}
console.log(JSON.stringify(nums(undefined)));
console.log(JSON.stringify(names(undefined)));
console.log(JSON.stringify(flags(undefined)));
console.log(JSON.stringify(nums(2)));
console.log(JSON.stringify(names("s")));
console.log(JSON.stringify(flags(false)));
console.log(nums(undefined).length, names(undefined).length, flags(undefined).length);
try {
  nums("s");
} catch (error) {
  console.log(\`\${error}\`);
}
`,
    );
    const built = await compile(entry, {
      outDir: dir,
      outPath: join(dir, "program"),
      backend: "llvm",
      sanitize: process.env["SCRIPTC_SAN"] === "1",
    });
    if (!built.ok) throw new Error(built.diagnostics.map((d) => d.message).join("\n"));
    const result = spawnSync(built.binaryPath, [], { timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      [
        "[null,1]",
        '[null,"a"]',
        "[null,true]",
        "[2,1]",
        '["s","a"]',
        "[false,true]",
        "2 2 2",
        "TypeError: expected number | undefined at $[0], got string",
        "",
      ].join("\n"),
    );
    expect(result.stderr.toString()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
