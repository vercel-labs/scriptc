// zlib options held in a typed object (a cast object literal that crosses
// into the options slot by reference) are read like a plain options
// object: levels, windowBits and strategies apply, and out-of-range values
// throw Node's ERR_OUT_OF_RANGE from the sync, callback, promisified and
// stream forms.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const data = Buffer.from("hello hello hello hello hello");
const stored = { level: 0 } as zlib.ZlibOptions;
const fast = { level: 1 } as zlib.ZlibOptions;
const huffman = { strategy: zlib.constants.Z_HUFFMAN_ONLY } as zlib.ZlibOptions;
const smallWindow = { windowBits: 9, memLevel: 1 } as zlib.ZlibOptions;
const badLevel = { level: 99 } as zlib.ZlibOptions;
const badWindow = { windowBits: 3 } as zlib.ZlibOptions;

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message);
  }
}

console.log("sync stored", zlib.deflateSync(data, stored).toString("hex"));
console.log("sync fast", zlib.deflateSync(data, fast).toString("hex"));
console.log("sync huffman", zlib.deflateSync(data, huffman).toString("hex"));
console.log("raw small window", zlib.deflateRawSync(data, smallWindow).toString("hex"));
console.log("gzip stored", zlib.gzipSync(data, stored).subarray(10).toString("hex"));
attempt("sync bad level", () => zlib.deflateSync(data, badLevel));
attempt("sync bad window", () => zlib.inflateSync(zlib.deflateSync(data), badWindow));
attempt("callback bad level", () => zlib.gzip(data, badLevel, () => console.log("not called")));
attempt("stream bad level", () => zlib.createDeflate(badLevel));

const deflateAsync = promisify(zlib.deflate);

async function main(): Promise<void> {
  const viaCallback = await new Promise<Buffer>((resolve, reject) =>
    zlib.deflate(data, stored, (err, out) => (err ? reject(err) : resolve(out))),
  );
  console.log("callback stored", viaCallback.toString("hex"));
  console.log("promise stored", (await deflateAsync(data, stored)).toString("hex"));
  try {
    await deflateAsync(data, badLevel);
    console.log("promise bad level fulfilled");
  } catch (e) {
    console.log("promise bad level", (e as NodeJS.ErrnoException).code);
  }
  const stream = zlib.createDeflate(fast);
  const parts: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => parts.push(chunk));
  stream.on("end", () => console.log("stream fast", Buffer.concat(parts).toString("hex")));
  stream.end(data);
}

main().catch((e) => console.log("unexpected", String(e)));
