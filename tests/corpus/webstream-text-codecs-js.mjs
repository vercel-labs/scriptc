// TextEncoderStream and TextDecoderStream: the chunks an encoder produces
// (including a surrogate pair split across writes and a lone surrogate held
// to the flush), the decoder's own input conversion and its per-encoding
// messages, BOM handling, fatal errors, split multi-byte sequences and the
// partial tail a flush completes, the other encodings it decodes, the
// constructor's argument order, and the identity of each stream's two sides.
const describe = (e) =>
  typeof e === "string" ? `string:${e}` : `${e?.code}:${e?.message}`;
const bytes = (v) => Array.from(v).join(",");
const show = (values) => values.map((v) => JSON.stringify(v)).join(" | ");

async function collect(readable) {
  const out = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

// Encodes the chunks and returns `[chunks, readableError]`.
async function encode(chunks) {
  const enc = new TextEncoderStream();
  const writer = enc.writable.getWriter();
  const reading = collect(enc.readable);
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  return reading;
}

// Decodes the chunks; a refused write also cuts the readable short with the
// same error, which the writer's abort carries.
async function decode(encoding, options, chunks) {
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

async function main() {
  // The two sides are the same objects every time they are read.
  {
    const enc = new TextEncoderStream();
    const dec = new TextDecoderStream();
    console.log("identity", enc.readable === enc.readable, enc.writable === enc.writable,
      dec.readable === dec.readable, dec.writable === dec.writable);
    console.log("classes", enc.readable instanceof ReadableStream, enc.writable instanceof WritableStream,
      dec.readable instanceof ReadableStream);
    const reader = dec.readable.getReader();
    console.log("locked", dec.readable.locked, dec.writable.locked);
    reader.releaseLock();
    console.log("unlocked", dec.readable.locked);
  }

  // An encoder's chunks are the UTF-8 bytes of the written strings, and its
  // chunk converts with ToString.
  {
    const chunks = await encode(["aé😀", "", "z", 5, true]);
    console.log("enc", chunks.map(bytes).join(" | "), chunks.map((c) => c.constructor.name).join(","));
    console.log("enc-encoding", new TextEncoderStream().encoding, new TextEncoderStream().fatal);
  }

  // A surrogate pair split across two writes reaches the bytes together; a
  // lone high surrogate waits for the flush, which replaces it.
  {
    console.log("enc-split", (await encode(["\ud83d", "\ude00"])).map(bytes).join(" | "));
    console.log("enc-lone", (await encode(["x\ud800", "y"])).map(bytes).join(" | "));
    const enc = new TextEncoderStream();
    const writer = enc.writable.getWriter();
    const reading = collect(enc.readable);
    await writer.write({ toString: () => "obj" });
    await writer.write(Symbol("sym"));
    await writer.close();
    console.log("enc-coerce", (await reading).map((c) => new TextDecoder().decode(c)).join(" | "));
  }

  // An encoder ignores a surplus constructor argument.
  console.log("enc-arg", new TextEncoderStream(5).encoding);

  // A decoder turns the bytes it is written into strings, holding a partial
  // multi-byte sequence until the next chunk or the flush.
  {
    console.log("dec", await decode(undefined, undefined,
      [new Uint8Array([0x68, 0xc3]), new Uint8Array([0xa9, 0x6c]), new Uint8Array([0x6c, 0x6f])]));
    console.log("dec-tail", await decode(undefined, undefined, [new Uint8Array([0xe2, 0x82])]));
    console.log("dec-bom", await decode(undefined, undefined,
      [new Uint8Array([0xef, 0xbb, 0xbf, 0x61])]));
    console.log("dec-keepbom", await decode(undefined, { ignoreBOM: true },
      [new Uint8Array([0xef, 0xbb, 0xbf, 0x61])]));
    console.log("dec-invalid", await decode(undefined, undefined, [new Uint8Array([0xff, 0x61])]));
    console.log("dec-fatal", await decode(undefined, { fatal: true }, [new Uint8Array([0xff, 0x61])]));
    console.log("dec-flags", new TextDecoderStream().fatal, new TextDecoderStream("utf-8", { fatal: 1, ignoreBOM: "x" }).ignoreBOM,
      new TextDecoderStream(undefined, { fatal: undefined, ignoreBOM: null }).fatal);
  }

  // An ArrayBuffer and a DataView are buffer sources.
  {
    console.log("dec-sources", await decode(undefined, undefined,
      [new TextEncoder().encode("hi").buffer, new DataView(new Uint8Array([33]).buffer)]));
  }

  // A chunk that is not a buffer source is refused: undefined names the
  // chunk itself, and every other value takes the decoder's own message,
  // which differs by encoding.
  {
    console.log("dec-undef", await decode(undefined, undefined, [undefined]));
    console.log("dec-bad-null", await decode(undefined, undefined, [null]));
    console.log("dec-bad-number", await decode(undefined, undefined, [5]));
    console.log("dec-bad-boolean", await decode(undefined, undefined, [true]));
    console.log("dec-bad-object", await decode(undefined, undefined, [{ a: 1 }]));
    console.log("dec-bad-array", await decode(undefined, undefined, [[1]]));
    console.log("dec-bad-symbol", await decode(undefined, undefined, [Symbol("s")]));
    console.log("dec-bad-string", await decode(undefined, undefined, ["x"]));
    console.log("dec-bad-u16-null", await decode("utf-16le", undefined, [null]));
    console.log("dec-bad-u16-string", await decode("utf-16le", undefined, ["x"]));
    console.log("dec-bad-latin1-null", await decode("latin1", undefined, [null]));
    console.log("dec-bad-latin1-string", await decode("latin1", undefined, ["x"]));
  }

  // The other encodings this runtime decodes: utf-16le and its BOM and split
  // surrogate, utf-16be, and the single-byte latin1 and windows-1252.
  {
    console.log("u16", await decode("utf-16le", undefined, [new Uint8Array([0x61, 0x00, 0xe9, 0x00])]));
    console.log("u16-bom", await decode("utf-16le", undefined, [new Uint8Array([0xff, 0xfe, 0x61, 0x00])]));
    console.log("u16-keepbom", await decode("utf-16le", { ignoreBOM: true }, [new Uint8Array([0xff, 0xfe, 0x61, 0x00])]));
    console.log("u16-split", await decode("utf-16le", undefined,
      [new Uint8Array([0x61, 0x00, 0x3d]), new Uint8Array([0xd8, 0x00, 0xde])]));
    console.log("u16-odd", await decode("utf-16le", undefined, [new Uint8Array([0x61, 0x00, 0x62])]));
    console.log("u16-odd-fatal", await decode("utf-16le", { fatal: true }, [new Uint8Array([0x61, 0x00, 0x62])]));
    console.log("u16be", await decode("utf-16be", undefined, [new Uint8Array([0x00, 0x61])]));
    console.log("latin1", await decode("latin1", undefined, [new Uint8Array([0xe9, 0x41])]));
    console.log("win1252", await decode("windows-1252", undefined, [new Uint8Array([0x80, 0x92])]));
  }

  // Labels normalize to the encoding they name.
  for (const label of ["UTF8", "utf-16", "latin1", "ISO-8859-1", "ucs-2"]) {
    console.log("label", label, new TextDecoderStream(label).encoding);
  }

  // The constructor converts its arguments in order: the options dictionary
  // before the label is validated, and a symbol label fails its string
  // conversion.
  {
    const construct = (label, make) => {
      try {
        console.log("construct", label, `ok:${make().encoding}`);
      } catch (e) {
        console.log("construct", label, describe(e));
      }
    };
    construct("number-label", () => new TextDecoderStream(5));
    construct("bad-label", () => new TextDecoderStream("nope"));
    construct("number-options", () => new TextDecoderStream("utf-8", 5));
    construct("both-bad", () => new TextDecoderStream("nope", 5));
    construct("null-options", () => new TextDecoderStream("utf-8", null));
    construct("array-options", () => new TextDecoderStream("utf-8", []));
    construct("function-options", () => new TextDecoderStream("utf-8", () => {}));
    construct("symbol-label", () => new TextDecoderStream(Symbol("s")));
  }

  // An abort discards the queued input and rejects both sides; a write after
  // close is refused.
  {
    const dec = new TextDecoderStream();
    const writer = dec.writable.getWriter();
    const reading = collect(dec.readable).then(
      (values) => show(values),
      (e) => `rejected:${describe(e)}`,
    );
    await writer.write(new Uint8Array([0x61]));
    await writer.abort("stop");
    console.log("abort", await reading, await writer.write(new Uint8Array([0x62])).then(() => "ok", describe));

    const enc = new TextEncoderStream();
    const w = enc.writable.getWriter();
    const done = collect(enc.readable).then(() => "done");
    await w.write("a");
    await w.close();
    console.log("close", await done, await w.write("b").then(() => "ok", describe));
  }
}

void main();
