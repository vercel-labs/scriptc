// A compression stream answers inherited and assigned callables as Node does,
// and instanceof answers through the class prototype without retaining it:
// the sanitized lane's reference audit covers the repeated checks.
const stream = new CompressionStream("gzip");
console.log("string", String(stream));
console.log("tostring", stream.toString());
const anyStream: any = stream;
anyStream.onUse = () => "used";
console.log("own", anyStream.onUse());
try {
  anyStream.missing();
} catch (error) {
  console.log("missing", (error as Error).message);
}
console.log("handle", stream instanceof CompressionStream);
for (let i = 0; i < 1000; i++) {
  if (({} as any) instanceof CompressionStream) console.log("plain-miss", i);
}
console.log("done");
