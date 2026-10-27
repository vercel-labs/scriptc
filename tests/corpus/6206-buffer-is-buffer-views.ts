// Buffer.isBuffer over Uint8Array-typed values reads the view's Buffer
// brand: Buffer factories, Buffer subarrays and slices are Buffers, plain
// typed arrays and copies into them are not.
function check(view: Uint8Array): boolean {
  return Buffer.isBuffer(view);
}
const plain = new Uint8Array([1, 2, 3]);
const buffer = Buffer.from(plain);
console.log(check(plain), check(buffer), check(Buffer.alloc(2)), check(Buffer.from("hey").subarray(1)));
console.log(check(plain.subarray(1)), check(new Uint8Array(buffer)), check(buffer.slice(1)), check(Buffer.concat([plain])));
const views: Uint8Array[] = [plain, buffer, new TextEncoder().encode("x"), Buffer.allocUnsafe(1)];
console.log(views.map((v) => Buffer.isBuffer(v)).join(","));
function words(view: Uint32Array): boolean {
  return Buffer.isBuffer(view);
}
console.log(words(new Uint32Array(2)), Buffer.from(plain).toString("hex"), Buffer.from(views[2]!).toString());
