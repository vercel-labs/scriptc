const cs = new CompressionStream("brotli");
const ds = new DecompressionStream("brotli");
console.log(typeof cs.readable, typeof ds.writable);
const writer = cs.writable.getWriter();
await writer.write(new TextEncoder().encode("written before any read"));
console.log("write resolved");
await writer.close();
const reader = cs.readable.getReader();
const parts: Uint8Array[] = [];
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  parts.push(value as Uint8Array);
}
const back = new DecompressionStream("brotli");
const bw = back.writable.getWriter();
const br = back.readable.getReader();
const decoded = (async () => {
  let text = "";
  for (;;) {
    const { value, done } = await br.read();
    if (done) break;
    text += Buffer.from(value as Uint8Array).toString();
  }
  return text;
})();
for (const part of parts) await bw.write(part);
await bw.close();
console.log("roundtrip", (await decoded) === "written before any read");
