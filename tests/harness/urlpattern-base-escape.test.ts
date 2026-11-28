/* URLPattern escape canonicalization behind a baseURL.
 *
 * The base resolver canonicalizes a pathname pattern's literal text, and an
 * escape before a name character is what ends the parameter name: in
 * `/:id\_suffix` the `_suffix` after the escape is a required literal, not
 * part of the name. Node's current baseURL processing refuses every escaped
 * pathname pattern (it matches nothing at all), so this cannot live in the
 * differential corpus; the standard's meaning is pinned here.
 *
 * SCRIPTC_SAN=1 builds these with ASan + the RC audit like every harness lane.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

async function compileAndRun(name: string, source: string): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `urlpattern-escape-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const { stdout } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
  return stdout;
}

test("a getter-backed or inherited ignoreCase option is read", async () => {
  // Node's URLPattern does not accept the options argument at all yet, so
  // this cannot be a differential case; the dictionary read is pinned here.
  const stdout = await compileAndRun(
    "ignore-case-options",
    `const plain = new URLPattern({ pathname: "/AbC" }, undefined, { ignoreCase: true });
console.log("plain", plain.test("https://h/abc"), plain.test("https://h/xyz"));
const proto = Object.create({ ignoreCase: true });
const inherited = new URLPattern({ pathname: "/AbC" }, undefined, proto);
console.log("inherited", inherited.test("https://h/abc"));
const getter: Record<string, unknown> = {};
Object.defineProperty(getter, "ignoreCase", { get() { return true; } });
const accessor = new URLPattern({ pathname: "/AbC" }, undefined, getter);
console.log("getter", accessor.test("https://h/abc"));
const off = new URLPattern({ pathname: "/AbC" }, undefined, { ignoreCase: false });
console.log("off", off.test("https://h/abc"));
`,
  );
  expect(stdout).toBe(
    ["plain true false", "inherited true", "getter true", "off false", ""].join("\n"),
  );
});

test("an escaped name character keeps the literal suffix required", async () => {
  const stdout = await compileAndRun(
    "base-escape",
    `const pattern = new URLPattern({ pathname: "/:id\\\\_suffix", baseURL: "https://h/a/b" });
for (const path of ["/123_suffix", "/123", "/123xyz"]) {
  console.log(path, pattern.test("https://h" + path));
}
const relative = new URLPattern({ pathname: "u/:id\\\\_suffix", baseURL: "https://h/a/b" });
for (const path of ["/a/u/7_suffix", "/a/u/7", "/a/u/7_other"]) {
  console.log("relative", path, relative.test("https://h" + path));
}
`,
  );
  expect(stdout).toBe(
    [
      "/123_suffix true",
      "/123 false",
      "/123xyz false",
      "relative /a/u/7_suffix true",
      "relative /a/u/7 false",
      "relative /a/u/7_other false",
      "",
    ].join("\n"),
  );
});
