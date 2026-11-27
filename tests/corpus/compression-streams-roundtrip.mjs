// CompressionStream and DecompressionStream over each of Node's formats:
// the streams carry text written in two chunks through one transform and
// read it back byte for byte, and the readable yields Uint8Array chunks.
async function roundtrip(format) {
  const text = `${format}:`.repeat(500);
  const cs = new CompressionStream(format);
  const reader = cs.readable.getReader();
  const writer = cs.writable.getWriter();
  const compressed = (async () => {
    const parts = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return parts;
  })();
  await writer.write(new TextEncoder().encode(text.slice(0, 700)));
  await writer.write(new TextEncoder().encode(text.slice(700)));
  await writer.close();
  const parts = await compressed;
  const ds = new DecompressionStream(format);
  const dreader = ds.readable.getReader();
  const dwriter = ds.writable.getWriter();
  const decoded = (async () => {
    let out = "";
    for (;;) {
      const { value, done } = await dreader.read();
      if (done) break;
      out += Buffer.from(value).toString();
    }
    return out;
  })();
  for (const part of parts) await dwriter.write(part);
  await dwriter.close();
  const back = await decoded;
  console.log(
    format,
    back === text,
    parts.length > 0,
    parts.every((p) => p instanceof Uint8Array && p.constructor.name === "Uint8Array"),
  );
}
for (const format of ["gzip", "deflate", "deflate-raw", "brotli"]) await roundtrip(format);
