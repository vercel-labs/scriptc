import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

// These refusals protect native layouts: a second Error.cause slot would
// disagree with accesses through the Error base class. (An asserted
// predicate of `.find` is no longer one of them: the element it answers is
// converted checked, see find-written-predicate.test.ts.)
test.each([
  [
    "cause field",
    `
    class Own extends Error { override cause = "own"; }
    const error: Error = new Own("message", { cause: "constructor" });
    console.log(error.cause);
  `,
    "redeclaring Error.cause",
  ],
  [
    "cause parameter property",
    `
    class Own extends Error {
      constructor(public override cause: string) { super("message"); }
    }
    console.log(new Own("own").cause);
  `,
    "redeclaring Error.cause",
  ],
  [
    "cause accessor",
    `
    class Options { get cause(): string { return "getter"; } }
    console.log(new Error("message", new Options()).cause);
  `,
    "Error options with a cause accessor",
  ],
  [
    "forwarded cause accessor",
    `
    class Options { get cause(): string { return "getter"; } }
    const options: ErrorOptions = new Options();
    console.log(new Error("message", options).cause);
  `,
    "Error options with a cause accessor",
  ],
] as const)("self-hosting boundary: %s", (_name, source, message) => {
  const dir = mkdtempSync(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "scriptc-static-boundary-"),
  );
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(entry, `export {};\n${source}`);
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed).toBe(false);
    expect(
      coverage.diagnostics.some((d) => d.code === "SC1090" && d.message.includes(message)),
      JSON.stringify(coverage.diagnostics),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
