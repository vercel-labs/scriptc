/* Error.stack positions in a release build.
 *
 * The differential corpus compares every build the same way, and positions
 * are deliberately release-only: a dev build names statements, and a
 * sanitized build keeps unpositioned frames (ASan instruments every frame
 * store). A release build records the call or throw site its frame is
 * running, so this pins that build's Error.stack against Node's own, with
 * the file elided (Node prints a file URL, the compiled binary an absolute
 * path) and loader frames dropped. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const sanitize = process.env["SCRIPTC_SAN"] === "1";

const PROGRAM = `const self = "positions.ts";

function frames(stack: string): string {
  const out: string[] = [];
  for (const raw of stack.split("\\n").slice(1)) {
    const line = raw.trim();
    const match = /^\\s*at (?:(.+?) \\()?(?:.*[\\\\/])?([^\\\\/():]+):(\\d+):(\\d+)\\)?$/.exec(line);
    if (match === null) continue;
    if (match[2] !== self) continue;
    const name = match[1] === undefined || match[1] === "Object.<anonymous>" ? "module" : match[1];
    out.push(\`\${name} \${match[3]} \${match[4]}\`);
  }
  return out.join(" | ");
}

function fail(): string {
  return new Error("boom").stack ?? "";
}

function middle(): string {
  return fail();
}

class Holder {
  fetch(): string {
    return middle();
  }
}

function thrower(): string {
  throw new Error("thrown");
}

function caughtThrow(): string {
  try {
    thrower();
  } catch (error) {
    return (error as Error).stack ?? "";
  }
  return "";
}

class CapturedError extends Error {
  constructor() {
    super("captured");
    Error.captureStackTrace(this, new.target);
  }
}
function captureConstructor(): string {
  return new CapturedError().stack ?? "";
}

function branchy(): string {
  let out = "";
  if (frames(middle()) !== "") {
    middle();
    out = "then";
  } else {
    middle();
    out = "else";
  }
  return out;
}

function sequenced(): string {
  let note = "";
  const stack = (note = "x", middle());
  return stack;
}

function sink(value: string): void {
  if (value === "never") throw new Error("no");
}

function loopCondition(stack: () => string): string {
  let out = "";
  for (let i = 0; i < 2 && (out = frames(stack())).length >= 0; i++) {
    sink(String(i));
  }
  return out;
}

console.log("capture", frames(middle()));
console.log("method", frames(new Holder().fetch()));
console.log("throw", frames(caughtThrow()));
console.log("module", frames(new Error("top").stack ?? ""));
console.log("if condition", branchy());
console.log("sequence", frames(sequenced()));
console.log("constructor", frames(captureConstructor()));
console.log("loop", loopCondition(middle));
`;

describe.skipIf(sanitize)("release Error.stack positions", () => {
  test("name the running call or throw site like Node", async () => {
    const key = createHash("sha256").update(PROGRAM).digest("hex").slice(0, 16);
    // Node refuses type stripping under node_modules, so the oracle's copy
    // lives in a private temporary directory.
    const outDir = mkdtempSync(join(tmpdir(), `scriptc-stack-positions-${key}-`));
    const file = join(outDir, "positions.ts");
    writeFileSync(file, PROGRAM);
    const result = await compile(file, {
      outPath: join(outDir, "positions"),
      outDir,
      backend: "llvm",
      optimization: "release",
    });
    if (!result.ok) {
      throw new Error(
        "stack positions program failed to compile:\n" +
          result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
      );
    }
    const { stdout: native } = await execFileAsync(result.artifact.path, [], { encoding: "utf8" });
    const { stdout: node } = await execFileAsync(process.execPath, [file], { encoding: "utf8" });
    expect(native).toBe(node);
  });
});
