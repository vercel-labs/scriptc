// Declarations that mention the WebAssembly API's types compile: the types
// have the checked-dynamic representation, and only a reached use of the
// API itself is refused. typeof needs no value and folds to Node's answer.
interface LoaderOptions {
  wasm?: BufferSource | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  memory?: WebAssembly.Memory;
}

function describe(name: string, options: LoaderOptions): string {
  const parts = [name];
  parts.push(options.wasm === undefined ? "no module" : "module given");
  parts.push(options.imports === undefined ? "no imports" : "imports given");
  return parts.join(", ");
}

console.log(describe("empty", {}));
console.log(describe("bytes", { wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) }));
console.log(typeof WebAssembly, typeof globalThis.WebAssembly);
console.log(typeof WebAssembly.compile, typeof WebAssembly.instantiate, typeof WebAssembly.validate);
console.log(typeof WebAssembly.Module, typeof WebAssembly.Instance, typeof WebAssembly.Memory);
console.log(typeof WebAssembly.RuntimeError, typeof WebAssembly.CompileError);
