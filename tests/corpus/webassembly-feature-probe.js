// A JavaScript dependency's WebAssembly glue: the feature probe answers as
// in Node, and the loader that would instantiate a module compiles (it is
// not reached here).
function supportsWasm() {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

async function instantiate(bytes, imports) {
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  return instance.exports;
}

const backend = process.argv.includes("--wasm") ? instantiate : null;
console.log("supports wasm:", supportsWasm());
console.log("backend:", backend === null ? "javascript" : "wasm");
