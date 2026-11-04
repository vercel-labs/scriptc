// Assemble the readable ABI fixtures with WABT 1.0.39's wat2wasm.
// Usage: node tests/wasm-spec/gen-simd-abi.mjs <wabt-bin-directory>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const tools = process.argv[2];
if (!tools) throw new Error("expected WABT bin directory");
if (execFileSync(join(tools, "wat2wasm"), ["--version"], { encoding: "utf8" }).trim() !== "1.0.39")
  throw new Error("expected WABT 1.0.39 release banner");
const temp = mkdtempSync(join(tmpdir(), "simd-abi-"));
try {
  const cases = {};
  for (const part of readFileSync(new URL("./simd-abi.wat", import.meta.url), "utf8")
    .split(";; ")
    .slice(1)) {
    const line = part.indexOf("\n"),
      name = part.slice(0, line),
      wat = part.slice(line + 1);
    writeFileSync(join(temp, "case.wat"), wat);
    execFileSync(join(tools, "wat2wasm"), [join(temp, "case.wat"), "-o", join(temp, "case.wasm")]);
    cases[name] = readFileSync(join(temp, "case.wasm")).toString("base64");
  }
  writeFileSync(
    new URL("./corpus/simd-abi.json", import.meta.url),
    JSON.stringify(cases, null, 2) + "\n",
  );
  const path = new URL("../corpus/webassembly-simd-abi/main.mjs", import.meta.url);
  const old = readFileSync(path, "utf8");
  writeFileSync(
    path,
    old.replace(
      /const (producer|consumer|jsImport|jsResult) = Buffer.from\('[^']*', 'base64'\);/g,
      (_, name) => `const ${name} = Buffer.from('${cases[name]}', 'base64');`,
    ),
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
