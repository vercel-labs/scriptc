// Buffer's numeric read/write methods with arguments that are not numbers
// (untyped JavaScript): Node validates them at runtime.
const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
const attempts = [
  () => buf.readUInt8("0"),
  () => buf.readUInt16LE("1"),
  () => buf.readInt32BE(true),
  () => buf.readDoubleLE(null),
  () => buf.writeUInt8(1, "0"),
  () => buf.writeUInt16BE("258", 0),
  () => buf.writeInt8("x", 0),
  () => buf.readUInt8(undefined),
  () => buf.readUInt8(1),
];
for (const attempt of attempts) {
  try {
    console.log("ok", attempt());
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}
console.log(Array.from(buf).join(","));
