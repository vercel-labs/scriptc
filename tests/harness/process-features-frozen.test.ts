import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// A member read of process.features (`process.features.ipv6`) is compiled
// as a constant, so the object the program can hold must never disagree
// with it. Node lets a program write nine of the flags and add keys of its
// own; a compiled binary refuses every such write with the TypeError of a
// frozen object, so this is a native-only contract and not a differential
// program. What it pins: no write, spelled or through an alias, a
// parameter, a held process object or Object.assign, changes the object,
// each one throws where it is made, and the direct read and the object
// agree afterwards.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-process-features-frozen-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

test("no write changes the process.features object, and each one throws where it is made", async () => {
  const { stdout, stderr, code } = await run(`const attempt = (label, write) => {
  let outcome = "no error";
  try {
    write();
  } catch (error) {
    outcome = error.constructor.name;
  }
  console.log(label, outcome);
};
const held = process.features;
attempt("direct", () => {
  process.features.ipv6 = false;
});
attempt("alias", () => {
  held.ipv6 = false;
});
attempt("parameter", () => {
  ((features) => {
    features.tls = !features.tls;
  })(process.features);
});
attempt("held process", () => {
  const pass = (value) => value;
  pass(process).features.uv = true;
});
attempt("Object.assign", () => {
  Object.assign(process.features, { inspector: true });
});
attempt("new key", () => {
  // The spelled write of a key Node does not define is refused at build time.
  Object.assign(held, { added: 1 });
});
attempt("defineProperty", () => {
  Object.defineProperty(held, "quic", { value: true });
});
console.log("direct", process.features.ipv6, process.features.tls, process.features.uv, process.features.inspector);
console.log("object", held.ipv6, held.tls, held.uv, held.inspector, "added" in held, held.debug, held.quic);
// The spelled delete of a flag is refused at build time.
console.log("keys", Object.keys(held).length, Object.isFrozen(held), Reflect.deleteProperty(held, "debug"));
`);
  expect(stderr).toBe("");
  expect(stdout).toBe(
    [
      "direct TypeError",
      "alias TypeError",
      "parameter TypeError",
      "held process TypeError",
      "Object.assign TypeError",
      "new key TypeError",
      "defineProperty TypeError",
      "direct true true false false",
      "object true true false false false false false",
      "keys 13 true false",
      "",
    ].join("\n"),
  );
  expect(code).toBe(0);
});
