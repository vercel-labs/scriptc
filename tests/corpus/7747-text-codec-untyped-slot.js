// TextEncoder and TextDecoder instances held in untyped storage (hono's
// StreamingApi keeps `this.encoder = new TextEncoder()` in a JavaScript
// class field) and called from dynamic code, with their identity, streaming
// state, properties, method values and argument errors.
class StreamingApi {
  /** @type {any} */ encoder;
  /** @type {any} */ decoder;
  /** @type {any} */ latin;
  /** @type {any} */ strict;
  constructor() {
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.latin = new TextDecoder("latin1");
    this.strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  }
  write(input) {
    if (typeof input === "string") input = this.encoder.encode(input);
    return input;
  }
}

const show = (error) => console.log(error.name, error.code);
const api = new StreamingApi();
console.log(api.write("héllo 😀"));
console.log(api.encoder.encoding, typeof api.encoder, api.encoder === api.encoder);
console.log(String(api.encoder), JSON.stringify(api.encoder), JSON.stringify({ d: api.decoder }));
console.log(api.encoder.encode(), api.encoder.encode(42), api.encoder.encode(undefined));
const dest = new Uint8Array(4);
console.log(api.encoder.encodeInto("héllo", dest), dest);
try {
  api.encoder.encodeInto(1, dest);
} catch (error) {
  show(error);
}

console.log(api.decoder.encoding, api.decoder.fatal, api.decoder.ignoreBOM);
console.log(api.latin.encoding, api.strict.fatal, api.strict.ignoreBOM);
const euro = api.encoder.encode("€uro");
const head = api.decoder.decode(euro.subarray(0, 2), { stream: true });
console.log(JSON.stringify(head), api.decoder.decode(euro.subarray(2)));
console.log(api.latin.decode(new Uint8Array([0xe9, 0x41])));
console.log(JSON.stringify(api.strict.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))));
try {
  api.strict.decode(new Uint8Array([0xff]));
} catch (error) {
  show(error);
}
try {
  api.decoder.decode("text");
} catch (error) {
  show(error);
}
console.log(JSON.stringify(api.decoder.decode()), JSON.stringify(api.decoder.decode(undefined, null)));

const encode = api.encoder.encode;
try {
  encode("x");
} catch (error) {
  console.log(error.name, error.code, error.message);
}
console.log(typeof api.encoder.encode, api.encoder.encode.length, api.encoder.encodeInto.length);
console.log(api.decoder.decode.length, encode === api.encoder.encode);
console.log(api.encoder.encode.call(api.encoder, "ab"));
console.log("encode" in api.encoder, "decode" in api.decoder, api.encoder.missing);

console.log(api.encoder instanceof TextEncoder, api.decoder instanceof TextDecoder);
console.log(api.encoder instanceof TextDecoder, JSON.parse("{}") instanceof TextEncoder);
const codecs = [api.encoder, api.decoder];
console.log(codecs.indexOf(api.decoder), codecs.includes(api.encoder));
