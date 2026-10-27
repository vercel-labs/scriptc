// TypeScript codecs crossing 'unknown' slots: boxed by reference and
// checked back, keeping identity and a decoder's streaming state.
const holder: { codec: unknown; decoder: unknown } = {
  codec: new TextEncoder(),
  decoder: new TextDecoder("utf-16le"),
};

const encoder = holder.codec as TextEncoder;
console.log(encoder.encode("typed"), encoder === (holder.codec as TextEncoder));
const decoder = holder.decoder as TextDecoder;
const bytes = new Uint8Array([0x68, 0x00, 0x69]);
console.log(JSON.stringify(decoder.decode(bytes, { stream: true })));
console.log(JSON.stringify(decoder.decode(new Uint8Array([0x00]))), decoder.encoding);

function store(value: unknown): unknown[] {
  return [value, value];
}
const pair = store(encoder);
console.log(pair[0] === pair[1], pair[0] === holder.codec);

const maybe: unknown = Math.random() > 2 ? 1 : new TextDecoder();
if (typeof maybe === "object" && maybe !== null) console.log((maybe as TextDecoder).encoding);

// Codecs inside arrays and records cross as their handles too.
const codecs: TextEncoder[] = [encoder, new TextEncoder()];
const asUnknown: unknown = codecs;
const back = asUnknown as TextEncoder[];
console.log(back.length, back[0] === encoder, back[1]!.encode("x"));
const streaming = new TextDecoder();
const nested: { name: string; decoder: TextDecoder } = { name: "nested", decoder: streaming };
const boxed: unknown = nested;
const unboxed = boxed as { name: string; decoder: TextDecoder };
console.log(unboxed.name, unboxed.decoder === streaming);
console.log(JSON.stringify(unboxed.decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true })));
console.log(JSON.stringify(streaming.decode(new Uint8Array([0xac]))));
console.log(JSON.stringify(boxed));
