// quickjs-wasi's WebAssembly extension loader, run through its own code:
// extensions.js is dist/extensions.js of quickjs-wasi 3.6.2, unmodified
// (MIT, LICENSE.quickjs-wasi). It parses the dylink.0 custom section
// (WebAssembly.Module.customSections), reads the extension's imports and
// exports (Module.imports, Module.exports), allocates the extension's data
// in the main module's memory, grows the shared function table and stores
// main-module functions in it (table.grow, table.set), creates
// __memory_base, __table_base and GOT globals (new WebAssembly.Global), and
// instantiates the extension against the main module's memory, table and
// stack pointer. The two modules stand in for quickjs.wasm and an
// extension .so; their text is in tests/wasm-spec/corpus/dylink-*.wat.
import { initExtension, loadExtension, parseDylink } from "./extensions.js";

const mainBytes = Buffer.from(
  "AGFzbQEAAAABEANgAX8Bf2AAAX9gAn9/AX8DBwYAAQECAgAEBAFwAAQFAwEAAgYTA38BQYCABAt/AUGACAt/AUEACweOAQkGbWVtb3J5AgAZX19pbmRpcmVjdF9mdW5jdGlvbl90YWJsZQEAD19fc3RhY2tfcG9pbnRlcgMABm1hbGxvYwAAE3Fqc19nZXRfY29udGV4dF9wdHIAARNxanNfZ2V0X3J1bnRpbWVfcHRyAAILanNfcmVnaXN0ZXIAAwdqc19jYWxsAAQGaGVscGVyAAUKXAYXAQF/IwEhASMBIABqQQ9qQXBxJAEgAQsFAEHkAAsFAEHIAQsZAEGABCMCQQRsaiABNgIAIwJBAWokAiMCCxMAIAFBgAQgAEEEbGooAgARAAALCAAgAEHoB2oL",
  "base64",
);
const extBytes = Buffer.from(
  "AGFzbQEAAAABEwRgAX8Bf2ACf38Bf2AAAGAAAX8C0AEKA2VudgZtZW1vcnkCAAEDZW52GV9faW5kaXJlY3RfZnVuY3Rpb25fdGFibGUBcAAAA2Vudg9fX3N0YWNrX3BvaW50ZXIDfwEDZW52DV9fbWVtb3J5X2Jhc2UDfwADZW52DF9fdGFibGVfYmFzZQN/AAdHT1QubWVtB2NvdW50ZXIDfwEIR09ULmZ1bmMGaGVscGVyA38BA2Vudgtqc19yZWdpc3RlcgABA2Vudg5taXNzaW5nX3N5bWJvbAAAA2VudgtzZWxmX3N5bWJvbAAAAwwLAAACAgEDAAAAAwMHogEJGF9fd2FzbV9hcHBseV9kYXRhX3JlbG9jcwAFEV9fd2FzbV9jYWxsX2N0b3JzAAYRcWpzX2V4dF9kZW1vX2luaXQABxVxanNfZXh0X2RlbW9fdmVyc2lvbnMACAtzZWxmX3N5bWJvbAAJCHVzZV9zZWxmAAoLdXNlX21pc3NpbmcACw1zdGFja19wb2ludGVyAAwMYnVtcF9jb3VudGVyAA0JCAEAIwILAgMECnYLBwAgAEEDbAsJACAAIwQRAAALCQAjAUEgaiQDCwkAIwNBBTYCAAsZACAAIwIQABogACMCQQFqEAAaIAFByAFrCwQAIwELBwAgAEEBagsGACAAEAILBgAgABABCwQAIwALFAAjAyMDKAIAQQFqNgIAIwMoAgALCxwBACMBCxZuYW1lPWRlbW8KdmVyc2lvbj0xLjIAABoIZHlsaW5rLjABBDACAgACCQEHbGliYy5zbw==",
  "base64",
);
// A module without a dylink.0 section (tests/wasm-spec/corpus/jsapi-own.wat).
const plainBytes = Buffer.from(
  "AGFzbQEAAAABBgFgAX8BfwMCAQAEBQFwAQIIBQQBAQEEBhICfwFBBwt8AEQAAAAAAAD4PwsHKgcDbWVtAgAEbWVtMgIAA3RhYgEAAWcDAAJnMgMABWZpeGVkAwECaWQAAAkHAQBBAQsBAAoGAQQAIAAL",
  "base64",
);

const failure = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : `threw ${String(e)}`);

const { instance } = await WebAssembly.instantiate(mainBytes, {});
const mainExports = instance.exports;
const table = mainExports.__indirect_function_table;

console.log("dylink", JSON.stringify(parseDylink(new WebAssembly.Module(extBytes))));
console.log("plain dylink", parseDylink(new WebAssembly.Module(plainBytes)));

const ext = await loadExtension({ name: "demo", wasm: extBytes }, mainExports, {}, {}, null);
console.log("loaded", ext.name, ext.memoryBase, ext.tableBase, ext.initFn);
console.log("versions", JSON.stringify(ext.versions));
console.log("dylink", JSON.stringify(ext.dylink));
console.log("table length", table.length, table.get(6) === mainExports.helper);
// The extension's own functions in the shared table, called from here.
const triple = table.get(4);
console.log("table functions", triple(14), table.get(5) === table.get(5), triple.name, triple.length);
console.log("module", ext.module instanceof WebAssembly.Module, ext.instance instanceof WebAssembly.Instance);

initExtension(ext, mainExports);
console.log("js_call", mainExports.js_call(0, 7), mainExports.js_call(1, 5));
const x = ext.instance.exports;
console.log("self symbol", x.use_self(41));
try {
  x.use_missing(1);
} catch (e) {
  console.log("missing symbol", failure(e));
}
console.log("stack pointer", x.stack_pointer(), mainExports.__stack_pointer.value);
mainExports.__stack_pointer.value = 60000;
console.log("shared stack pointer", x.stack_pointer());
console.log("counter", x.bump_counter(), x.bump_counter());
console.log("memory", new Uint32Array(mainExports.memory.buffer, ext.memoryBase + 32, 1)[0]);

// Snapshot restore (what restoreExtensions does per extension): the same
// bases, from a compiled Module, without init.
const restored = await loadExtension(
  { name: "demo", wasm: new WebAssembly.Module(extBytes) },
  mainExports,
  {},
  {},
  null,
  { memoryBase: ext.memoryBase, tableBase: ext.tableBase },
);
console.log("restored", restored.memoryBase, restored.tableBase, table.length);
console.log("restored counter", restored.instance.exports.bump_counter());

// A second extension instance gets its own bases.
const second = await loadExtension({ name: "demo", wasm: extBytes }, mainExports, {}, {}, null);
console.log("second", second.memoryBase, second.tableBase, table.length);
initExtension(second, mainExports);
console.log("js_call", mainExports.js_call(2, 10), mainExports.js_call(3, 10));

async function tryLoad(label, wasm, exports) {
  try {
    await loadExtension({ name: label, wasm }, exports, {}, {}, null);
    console.log(label, "loaded");
  } catch (e) {
    console.log(label, failure(e));
  }
}
await tryLoad("plain", plainBytes, mainExports);
await tryLoad("no memory", extBytes, { ...mainExports, memory: undefined });
await tryLoad("no table", extBytes, { ...mainExports, __indirect_function_table: undefined });
try {
  initExtension({ ...ext, initFn: "qjs_ext_none_init" }, mainExports);
} catch (e) {
  console.log("init", failure(e));
}
try {
  initExtension(ext, { ...mainExports, qjs_get_runtime_ptr: () => 201 });
} catch (e) {
  console.log("init", failure(e));
}
