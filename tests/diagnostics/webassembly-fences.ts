// The parts of the WebAssembly API scriptc does not implement yet refuse at
// each reached use, in each spelling. compile, instantiate, validate, the
// Module, Instance, Memory, Table and Global constructors, Module.imports,
// exports and customSections, and the error classes compile
// (tests/corpus/webassembly-*).
async function load(bytes: Uint8Array): Promise<void> {
  const module = await WebAssembly.compile(bytes);
  console.log(WebAssembly.Module.imports(module).length);
  const streamed = await WebAssembly.instantiateStreaming(fetch("https://example.com/x.wasm"));
  console.log(streamed.instance);
  const Ctor = WebAssembly.Module;
  console.log(Ctor);
  const Memory = WebAssembly.Memory;
  console.log(new Memory({ initial: 1 }));
}

await load(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
