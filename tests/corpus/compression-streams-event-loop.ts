// CompressionStream runs its codec on the worker pool, as node:zlib's
// writes do, so compressing a large payload leaves the event loop free:
// immediates keep running while 4 MiB go through the stream. The compressed
// bytes are decompressed again so the pipeline's output stays honest.

const CHUNK = 1024 * 1024;
const COUNT = 4;

function makePayload(): Uint8Array {
  const bytes = new Uint8Array(CHUNK * COUNT);
  let x = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

async function main(): Promise<void> {
  const payload = makePayload();
  const stream = new CompressionStream("gzip");
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  let running = true;
  let turns = 0;
  const keepAlive = () => {
    if (!running) return;
    turns++;
    setImmediate(keepAlive);
  };
  // The chain starts on the next turn: a turn of its own is not work done
  // while the engine runs.
  setImmediate(keepAlive);

  const parts: Uint8Array[] = [];
  const draining = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  })();

  for (let offset = 0; offset < payload.length; offset += CHUNK) {
    await writer.write(payload.subarray(offset, offset + CHUNK));
  }
  await writer.close();
  await draining;
  running = false;

  console.log("compressed", parts.length > 0);
  console.log("event loop ran during compression", turns > 0);

  const back = new DecompressionStream("gzip");
  const backReader = back.readable.getReader();
  const backWriter = back.writable.getWriter();
  const decoded = (async () => {
    const pieces: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await backReader.read();
      if (done) break;
      pieces.push(value);
    }
    let total = 0;
    for (const piece of pieces) total += piece.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  })();
  for (const part of parts) await backWriter.write(part);
  await backWriter.close();
  const out = await decoded;
  let same = out.length === payload.length;
  for (let i = 0; same && i < out.length; i++) if (out[i] !== payload[i]) same = false;
  console.log("roundtrip", same);
}

await main();
