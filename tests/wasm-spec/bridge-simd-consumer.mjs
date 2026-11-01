// Generate a reduced consumer for the exact bridge artifact tested in #1679.
// The real WASM stays outside the repository; unexpected host calls fail.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const [artifact, output] = process.argv.slice(2);
if (!artifact || !output)
  throw new Error(
    "Usage: node tests/wasm-spec/bridge-simd-consumer.mjs <bridge.wasm> <new-output-directory>",
  );
const bytes = readFileSync(artifact);
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "7f563e4853e056a3063d3d82d7e3ee94004efa6ad267185040eca32fef1897b4"
)
  throw new Error("Expected @oxidezap/whatsapp-rust-bridge@0.26.0 WASM bytes");
const path = resolve(output);
mkdirSync(path);
copyFileSync(artifact, path + "/bridge.wasm");
writeFileSync(
  path + "/package.json",
  JSON.stringify({ private: true, type: "module", scriptc: { wasm: ["bridge.wasm"] } }) + "\n",
);
const module = new WebAssembly.Module(bytes);
if (
  WebAssembly.Module.imports(module).some(
    (im) => im.kind !== "function" || im.module !== "./whatsapp_rust_bridge_bg.js",
  )
)
  throw new Error("Unexpected bridge import shape");
const used = new Map([
  ["__wbg_new_with_length_5ffeddb9d9fbb96f", "newBytes"],
  ["__wbg_length_31bdaf014f5fbde2", "byteLength"],
  ["__wbg_set_5f2ad37e5e02dc7b", "setBytes"],
]);
const entries = WebAssembly.Module.imports(module)
  .map(
    (im) =>
      `    ${JSON.stringify(im.name)}: ${used.get(im.name) || `(): never => unexpected(${JSON.stringify(im.name)})`},`,
  )
  .join("\n");
writeFileSync(
  path + "/main.ts",
  `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const bytes = readFileSync(fileURLToPath(new URL("./bridge.wasm", import.meta.url)));
console.log("valid", WebAssembly.validate(bytes));
const module = new WebAssembly.Module(bytes);
const heap: (Uint8Array | undefined)[] = new Array(132);
function getBytes(index: number): Uint8Array {
  const value = heap[index];
  if (value === undefined) throw new Error("Invalid host byte-array index");
  return value;
}
function newBytes(length: number): number {
  heap.push(new Uint8Array(length >>> 0));
  return heap.length - 1;
}
function byteLength(index: number): number { return getBytes(index).length; }
function setBytes(index: number, pointer: number, length: number): void {
  getBytes(index).set(new Uint8Array(x.memory.buffer, pointer >>> 0, length >>> 0));
}
function unexpected(name: string): never { throw new Error("Unexpected WASM host call: " + name); }
const instance = new WebAssembly.Instance(module, {
  "./whatsapp_rust_bridge_bg.js": {
${entries}
  }
});
const x = instance.exports as {
  memory: WebAssembly.Memory;
  __wbindgen_export(size: number, align: number): number;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  sha256(result: number, input: number, length: number): void;
};
for (const size of [0, 3, 64, 1024, 65536]) {
  const input = new Uint8Array(size);
  for (let i = 0; i < size; i++) input[i] = (i * 17 + 23) & 255;
  const pointer = x.__wbindgen_export(input.length, 1);
  new Uint8Array(x.memory.buffer, pointer, input.length).set(input);
  const result = x.__wbindgen_add_to_stack_pointer(-16);
  x.sha256(result, pointer, input.length);
  const record = new Int32Array(x.memory.buffer, result, 4);
  if (record[2] !== 0) throw new Error("WASM SHA-256 returned an error");
  const actual = Buffer.from(getBytes(record[0]!)).toString("hex");
  const expected = createHash("sha256").update(input).digest("hex");
  if (actual !== expected) throw new Error("WASM SHA-256 mismatch");
  console.log(size, actual);
  x.__wbindgen_add_to_stack_pointer(16);
}
`,
);
