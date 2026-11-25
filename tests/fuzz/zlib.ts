// Decompression of damaged streams: inflate, gunzip, raw inflate, brotli, zstd, and unzip with a sync flush and an
// output limit. The seeds are valid streams of each format; a case flips, overwrites and cuts their bytes.
// Case fields: the stream as hex.
import * as zlib from "node:zlib";
import { type Case, field, note, noteStr, ri, rnd, seedField } from "./fz.ts";

export function generate(seeds: Case[]): Case {
  const b = Buffer.from(seedField(seeds, 2), "hex");
  if (b.length > 0) {
    for (let k = ri(6) + 1; k > 0; k--) {
      const at = ri(b.length);
      const op = ri(3);
      if (op === 0) b[at] = ri(256);
      else if (op === 1) b[at] = (b[at] ?? 0) ^ (1 << ri(8));
      else b[at] = 0xff;
    }
  }
  const cut = ri(4) === 0 ? b.subarray(0, ri(b.length)) : b;
  return [String(ri(6)), String(rnd()), cut.toString("hex")];
}

export function execute(c: Case): void {
  const mode = Number(field(c, 0));
  const input = Buffer.from(field(c, 2), "hex");
  try {
    let out: Buffer;
    if (mode === 0) out = zlib.inflateSync(input);
    else if (mode === 1) out = zlib.gunzipSync(input);
    else if (mode === 2) out = zlib.inflateRawSync(input);
    else if (mode === 3) out = zlib.brotliDecompressSync(input);
    else if (mode === 4) out = zlib.zstdDecompressSync(input);
    else out = zlib.unzipSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 1 << 16 });
    note(out.length);
    noteStr(out.toString("latin1", 0, 64));
    note(1);
  } catch (e) {
    note(2);
  }
}
