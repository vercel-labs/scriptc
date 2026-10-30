// zlib's Brotli forms through their TypeScript types: typed options,
// dictionaries, maxOutputLength, the callback and promisified forms, and the
// BrotliCompress and BrotliDecompress classes.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const input: string = "typed brotli ".repeat(64);
const compressed: Buffer = zlib.brotliCompressSync(input, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
});
console.log(compressed.toString("base64"));
console.log(zlib.brotliDecompressSync(compressed).toString() === input);
const dict: Buffer = Buffer.from("typed brotli");
const withDict = zlib.brotliCompressSync(input, { dictionary: dict });
console.log(withDict.length, zlib.brotliDecompressSync(withDict, { dictionary: dict }).length);
try {
  zlib.brotliDecompressSync(compressed, { maxOutputLength: 16 });
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.log(err.code, err.message);
}
zlib.brotliCompress(Buffer.from("abc"), (err, out) => {
  console.log(err, out.toString("hex"));
  zlib.brotliDecompress(out, { finishFlush: zlib.constants.BROTLI_OPERATION_FINISH }, (err2, back) => {
    console.log(err2, back.toString());
    main();
  });
});
const compressAsync = promisify(zlib.brotliCompress);
const decompressAsync = promisify(zlib.brotliDecompress);
async function main(): Promise<void> {
  const packed = await compressAsync("promised");
  console.log((await decompressAsync(packed)).toString());
  try {
    await decompressAsync(Buffer.from([0xff]));
  } catch (e) {
    console.log((e as NodeJS.ErrnoException).code);
  }
  const stream: zlib.BrotliCompress = new zlib.BrotliCompress();
  const parts: Buffer[] = [];
  stream.on("data", (c: Buffer) => parts.push(c));
  stream.on("end", () => console.log("stream", Buffer.concat(parts).equals(zlib.brotliCompressSync("streamed")), stream.bytesWritten));
  stream.end("streamed");
  const dec = zlib.createBrotliDecompress();
  dec.reset();
  console.log(dec instanceof zlib.BrotliDecompress);
}
