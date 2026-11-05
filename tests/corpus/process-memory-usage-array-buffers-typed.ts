// process.memoryUsage() in typed code counts the storage of typed arrays
// and Buffers created there, and a subarray view adds nothing.
const size = 2 * 1024 * 1024;
function grew(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage): string {
  return `${after.arrayBuffers - before.arrayBuffers >= size} ${after.external - before.external >= size}`;
}

let before = process.memoryUsage();
const bytes = new Uint8Array(size);
console.log("Uint8Array", bytes.length, grew(before, process.memoryUsage()));

before = process.memoryUsage();
const ints = new Int32Array(size / 4);
ints[0] = 7;
console.log("Int32Array", ints.length, ints[0], grew(before, process.memoryUsage()));

before = process.memoryUsage();
const buf = Buffer.alloc(size);
buf[1] = 3;
console.log("Buffer.alloc", buf.length, grew(before, process.memoryUsage()));

before = process.memoryUsage();
const copy = Uint8Array.from(bytes);
console.log("Uint8Array.from", copy.length, grew(before, process.memoryUsage()));

before = process.memoryUsage();
const view = bytes.subarray(16);
const after = process.memoryUsage();
console.log("subarray", view.length, after.arrayBuffers - before.arrayBuffers < size);
