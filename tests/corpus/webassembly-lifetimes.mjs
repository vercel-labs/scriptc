// Lifetimes across the WebAssembly boundary: an externref read from a table
// or global outlives the slot being cleared, a fresh import result reaches
// JavaScript from an export, a load with an explicit memory index reads its
// own offset, and a Memory's buffer outlives the Memory. The module's text
// is in tests/wasm-spec/corpus/lifetimes.wat.
const lifetimes = Buffer.from(
  "AGFzbQEAAAABDQNgAW8AYAABb2AAAX8CDAEDZW52BG1ha2UAAQMHBgABAAEBAgQEAW8AAQUDAQABBgYBbwHQbwsHLAYDcHV0AAEEdGFrZQACBHB1dGcAAwV0YWtlZwAEBWZyZXNoAAUEbG9hZAAGCjsGCABBACAAJgALEgEBb0EAJQAhAEEA0G8mACAACwYAIAAkAAsIACMA0G8kAAsEABAACwgAQQAoQgAICwsKAQBBCAsEYWJjZA==",
  "base64",
);

const { instance } = await WebAssembly.instantiate(lifetimes, {
  env: { make: () => ({ made: [1, 2, 3] }) },
});
const x = instance.exports;

x.put({ from: "table" });
console.log(x.take());
x.putg({ from: "global" });
console.log(x.takeg());
console.log(x.fresh());
console.log(x.fresh().made.length);
console.log(x.load().toString(16));

function viewOfDroppedMemory() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  bytes[0] = 7;
  bytes[65535] = 9;
  return bytes;
}
const view = viewOfDroppedMemory();
const filler = [];
for (let i = 0; i < 32; i++) filler.push(new Uint8Array(65536).fill(1));
view[1] = 5;
console.log(view.length, view[0], view[1], view[65535], filler.length);

function bufferOfDroppedMemory() {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  new Uint8Array(memory.buffer)[3] = 42;
  return memory.buffer;
}
const buffer = bufferOfDroppedMemory();
console.log(buffer.byteLength, new Uint8Array(buffer)[3]);
