function compactRecords(input: Buffer, output: Buffer): number {
  let position = 0;
  for (let offset = 0; offset < input.length; offset += 8) {
    const id = input.readUInt32LE(offset);
    const tail = offset + 4;
    const value = input.readUInt32LE(tail);
    if ((id & 1) === 0) continue;
    output.writeUInt32BE((id + value) >>> 0, position);
    position += 4;
    if (position === 12) break;
  }
  return position;
}
function changeRecords(view: DataView, little: boolean): number {
  let checksum = 0;
  for (let offset = 0; offset < view.byteLength; offset += 8) {
    const tail = offset + 4;
    const id = view.getInt32(offset, little);
    const value = view.getFloat32(tail, little);
    view.setInt32(offset, id ^ 0x80000000, !little);
    view.setFloat32(tail, value / 2, !little);
    checksum = (checksum + id) | 0;
  }
  return checksum;
}
function advanceFirst(input: Buffer, output: Buffer): number {
  let position = 0;
  for (let offset = 0; offset < input.length; offset += 8) {
    const left = input.readUInt32LE(offset);
    const right = input.readUInt32LE(offset + 4);
    if (left === 1) position += 4;
    else position += 8;
    output.writeUInt32LE((left ^ right) >>> 0, position);
    position += 4;
  }
  return position;
}
function invalidValue(input: Buffer, output: Buffer, value: number): void {
  let position = 0;
  for (let offset = 0; offset < input.length; offset += 8) {
    const left = input.readUInt32LE(offset);
    const right = input.readUInt32LE(offset + 4);
    output.writeUInt16LE(value + left - right, position);
    position += 2;
  }
}
function replaced(input: Buffer): number {
  let total = 0;
  for (let offset = 0; offset < input.length; offset += 8) {
    const left = input.readUInt32LE(offset);
    input = Buffer.alloc(4, 2);
    total += left + input.readUInt32LE(offset + 4);
  }
  return total;
}
function bytePairs(input: Uint8Array, output: Uint8Array): number {
  let position = 0;
  for (let offset = 0; offset < input.length; offset += 2) {
    const second = offset + 1;
    const value = input[offset]! ^ input[second]!;
    if (value === 0) continue;
    output[position] = value;
    position += 1;
  }
  return position;
}
function earlyReturn(input: Buffer): number {
  for (let offset = 0; offset < input.length; offset += 8) {
    const left = input.readUInt32LE(offset);
    const right = input.readUInt32LE(offset + 4);
    if (left === 3) return left + right;
  }
  return -0;
}
const storage = Buffer.alloc(43, 0xa5);
const records = storage.subarray(1, 41);
for (let i = 0; i < 5; i++) {
  records.writeUInt32LE(i + 1, i * 8);
  records.writeUInt32LE(0xffffffff - i, i * 8 + 4);
}
for (const length of [0, 7, 8, 16, 40]) {
  for (const capacity of [0, 3, 4, 20]) {
    const output = Buffer.alloc(capacity, 0x33);
    try {
      console.log("compact", length, capacity, compactRecords(records.subarray(0, length), output), output.toString("hex"));
    } catch (error) {
      if (error instanceof Error) console.log("compact-error", length, capacity, error.name, error.message, output.toString("hex"));
    }
  }
}
for (const little of [false, true]) {
  const data = Buffer.alloc(19, 0x5a);
  const view = new DataView(data.buffer, data.byteOffset + 1, 16);
  view.setInt32(0, -2147483648, little);
  view.setFloat32(4, -0, little);
  view.setInt32(8, 2147483647, little);
  view.setFloat32(12, 1.5, little);
  console.log("view", little, changeRecords(view, little), data.toString("hex"));
  try { changeRecords(new DataView(data.buffer, data.byteOffset + 1, 15), little); }
  catch (error) { if (error instanceof Error) console.log("view-error", error.name, error.message, data.toString("hex")); }
}
for (const capacity of [8, 20, 64, 96]) {
  const output = Buffer.alloc(capacity, 0x77);
  try { console.log("progress", capacity, advanceFirst(records, output), output.toString("hex")); }
  catch (error) { if (error instanceof Error) console.log("progress-error", capacity, error.name, error.message, output.toString("hex")); }
}
const equalFields = Buffer.alloc(16);
for (const value of [-1, 65536, NaN, -0, 1.75]) {
  for (const capacity of [0, 4]) {
    const output = Buffer.alloc(capacity, 0x88);
    try { invalidValue(equalFields, output, value); console.log("value", value, capacity, output.toString("hex")); }
    catch (error) { if (error instanceof Error) console.log("value-error", value, capacity, error.name, error.message); }
  }
}
try { replaced(records); }
catch (error) { if (error instanceof Error) console.log("replace", error.name, error.message); }
const pairInput = new Uint8Array([1, 2, 5, 5, 8, 9]);
for (const capacity of [3, 4]) {
  const output = new Uint8Array(capacity);
  console.log("pairs", capacity, bytePairs(pairInput, output), Array.from(output).join(","));
}
console.log("return", earlyReturn(records), Object.is(earlyReturn(Buffer.alloc(0)), -0), storage.toString("hex"));

function seededRecords(input: Buffer, output: Buffer, position: number): number {
  for (let offset = 0; offset < input.length; offset += 8) {
    const left = input.readUInt32LE(offset);
    const right = input.readUInt32LE(offset + 4);
    output.writeUInt32BE((left + right) >>> 0, position);
    position += 4;
  }
  return position;
}
for (const seed of [0, -0, 4, 0.5, -1, Infinity, 9007199254740992]) {
  const output = Buffer.alloc(16, 0x22);
  try { console.log("seed", seed, seededRecords(records.subarray(0, 16), output, seed), output.toString("hex")); }
  catch (error) { if (error instanceof Error) console.log("seed-error", seed, error.name, error.message, output.toString("hex")); }
}
