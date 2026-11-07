// Typed TextEncoderStream and TextDecoderStream: the encoding each reports,
// the identity of a stream's two sides, an encoder's bytes decoded back
// through a pipe, split and lone surrogates, the decoder's BOM and fatal
// handling, split multi-byte sequences and the partial tail a flush
// completes, the single-byte and utf-16 encodings, label normalization, and
// the refusals a typed program reaches.
function describe(e: unknown): string {
  if (typeof e === "string") return `string:${e}`;
  const err = e as { code?: string; message?: string };
  return `${err.code}:${err.message}`;
}

async function collect(readable: ReadableStream<string>): Promise<string[]> {
  const out: string[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const show = (values: string[]): string => values.map((v) => JSON.stringify(v)).join(" | ");

// Decodes the chunks; a refused write cuts the readable short with the same
// error.
async function decode(
  encoding: string | undefined,
  options: { fatal?: boolean; ignoreBOM?: boolean } | undefined,
  chunks: Uint8Array[],
): Promise<string> {
  const dec = new TextDecoderStream(encoding, options);
  const writer = dec.writable.getWriter();
  const reading = collect(dec.readable).then(
    (values) => show(values),
    (e) => `rejected:${describe(e)}`,
  );
  let refused = "accepted";
  try {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  } catch (e) {
    refused = describe(e);
    await writer.abort().catch(() => {});
  }
  return `${refused} ${await reading}`;
}

async function main(): Promise<void> {
  // The two sides are the same objects every time they are read.
  {
    const enc = new TextEncoderStream();
    const dec = new TextDecoderStream();
    console.log(
      "identity",
      enc.readable === enc.readable,
      enc.writable === enc.writable,
      dec.readable === dec.readable,
      dec.writable === dec.writable,
    );
    const reader = dec.readable.getReader();
    console.log("locked", dec.readable.locked, dec.writable.locked);
    reader.releaseLock();
    console.log("unlocked", dec.readable.locked);
  }

  // An encoder's chunks are the UTF-8 bytes of the written strings: the
  // stream decoded back through a decoder returns them.
  {
    const enc = new TextEncoderStream();
    const writer = enc.writable.getWriter();
    const reading = collect(enc.readable.pipeThrough(new TextDecoderStream()));
    await writer.write("aé😀");
    await writer.write("");
    await writer.write("z");
    await writer.close();
    console.log("enc-roundtrip", JSON.stringify((await reading).join("")));
  }

  // A surrogate pair split across two writes reaches the bytes together; a
  // lone high surrogate waits for the flush, which replaces it.
  {
    const enc = new TextEncoderStream();
    const writer = enc.writable.getWriter();
    const reading = collect(enc.readable.pipeThrough(new TextDecoderStream()));
    await writer.write("\ud83d");
    await writer.write("\ude00");
    await writer.write("x\ud800");
    await writer.write("y");
    await writer.close();
    console.log("enc-surrogates", JSON.stringify((await reading).join("")));
  }

  // A decoder holds a partial multi-byte sequence until the next chunk, and
  // replaces the partial tail at the flush.
  {
    console.log("dec", await decode(undefined, undefined, [new Uint8Array([0x68, 0xc3]), new Uint8Array([0xa9, 0x6c])]));
    console.log("dec-tail", await decode(undefined, undefined, [new Uint8Array([0xe2, 0x82])]));
    console.log("dec-invalid", await decode(undefined, undefined, [new Uint8Array([0xff, 0x61])]));
    console.log("dec-bom", await decode(undefined, { ignoreBOM: true }, [new Uint8Array([0xef, 0xbb, 0xbf, 0x61])]));
  }

  // A fatal decoder refuses invalid bytes, and both sides carry the error.
  {
    const dec = new TextDecoderStream("utf-8", { fatal: true });
    console.log("fatal-flags", dec.encoding, dec.fatal, dec.ignoreBOM);
    const writer = dec.writable.getWriter();
    const reading = collect(dec.readable).then(
      (values) => show(values),
      (e) => `rejected:${describe(e)}`,
    );
    console.log("fatal-write", await writer.write(new Uint8Array([0xff, 0x61])).then(() => "accepted", describe));
    console.log("fatal-read", await reading);
  }

  // The other encodings: utf-16le with its BOM and split surrogate, utf-16be,
  // and the single-byte latin1 and windows-1252.
  {
    console.log("u16", await decode("utf-16le", undefined, [new Uint8Array([0x61, 0x00, 0xe9, 0x00])]));
    console.log("u16-bom", await decode("utf-16le", undefined, [new Uint8Array([0xff, 0xfe, 0x61, 0x00])]));
    console.log("u16-split", await decode("utf-16le", undefined, [new Uint8Array([0x61, 0x00, 0x3d]), new Uint8Array([0xd8, 0x00, 0xde])]));
    console.log("u16-odd", await decode("utf-16le", undefined, [new Uint8Array([0x61, 0x00, 0x62])]));
    console.log("u16-odd-fatal", await decode("utf-16le", { fatal: true }, [new Uint8Array([0x61, 0x00, 0x62])]));
    console.log("u16be", await decode("utf-16be", undefined, [new Uint8Array([0x00, 0x61])]));
    console.log("latin1", await decode("latin1", undefined, [new Uint8Array([0xe9, 0x41])]));
    console.log("win1252", await decode("windows-1252", undefined, [new Uint8Array([0x80, 0x92])]));
  }

  // Labels normalize to the encoding they name, and one that names nothing
  // is refused.
  for (const label of ["UTF8", "utf-16", "latin1", "ISO-8859-1", "ucs-2"]) {
    console.log("label", label, new TextDecoderStream(label).encoding);
  }
  try {
    console.log("label-nope", new TextDecoderStream("nope").encoding);
  } catch (e) {
    console.log("label-nope", describe(e));
  }

  // A write after close is refused, and an abort rejects both sides.
  {
    const enc = new TextEncoderStream();
    const writer = enc.writable.getWriter();
    const done = collect(enc.readable.pipeThrough(new TextDecoderStream())).then(() => "done");
    await writer.write("a");
    await writer.close();
    console.log("close", await done, await writer.write("b").then(() => "ok", describe));

    const dec = new TextDecoderStream();
    const w = dec.writable.getWriter();
    const reading = collect(dec.readable).then(
      (values) => show(values),
      (e) => `rejected:${describe(e)}`,
    );
    await w.write(new Uint8Array([0x61]));
    await w.abort("stop");
    console.log("abort", await reading);
  }
}

void main();
