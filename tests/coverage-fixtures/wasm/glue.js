import { existsSync } from "node:fs";

// (module (func (export "answer") (result i32) i32.const 42)), inlined the
// way undici inlines llhttp.
const ANSWER = "AGFzbQEAAAABBQFgAAF/AwIBAAcKAQZhbnN3ZXIAAAoGAQQAQSoL";

export function hasModule() {
  return existsSync(new URL("./add.wasm", import.meta.url).pathname);
}

// WebAssembly shared libraries (quickjs-wasi's extensions) use .so: ext.so
// is a module, native.so is not and is not reported.
export function sharedLibraries() {
  return [
    existsSync(new URL("./ext.so", import.meta.url).pathname),
    existsSync(new URL("./native.so", import.meta.url).pathname),
  ];
}

export function inlineModule() {
  return ANSWER;
}

export async function instantiate(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}
