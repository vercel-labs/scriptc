// TextDecoder's errors as Node throws them: a fatal decoder's invalid data
// names its encoding, a decode input that is not a buffer source throws
// ERR_INVALID_ARG_TYPE with each decoder's wording, options outside an
// object literal are checked (null, objects and functions pass), and
// TextEncoder.encode(undefined) encodes "".
const show = (label, f) => {
  try {
    console.log(label, JSON.stringify(f()));
  } catch (e) {
    console.log(label, e.name, e.code, e.message);
  }
};

for (const encoding of ["utf-8", "utf-16le", "utf-16be", "iso-8859-3", "gbk", "shift_jis"]) {
  const bytes = encoding === "utf-16be" ? [0x00] : encoding === "iso-8859-3" ? [0xa5] : [0xff];
  show(`fatal ${encoding}`, () => new TextDecoder(encoding, { fatal: true }).decode(new Uint8Array(bytes)));
}
const odd = new TextDecoder("utf-16le", { fatal: true });
show("fatal stream", () => [odd.decode(new Uint8Array([0x00, 0x00]), { stream: true }), odd.decode(new Uint8Array([0x00]))]);

for (const encoding of ["utf-8", "utf-16le", "windows-1252", "euc-kr"]) {
  const decoder = new TextDecoder(encoding);
  for (const input of [false, "ab", null, 5, {}, [1]]) show(`input ${encoding} ${JSON.stringify(input)}`, () => decoder.decode(input));
}
const streaming = new TextDecoder();
show("input stream", () => streaming.decode(false, { stream: true }));
show("input pending", () => [streaming.decode(new Uint8Array([0xe2]), { stream: true }), streaming.decode(true)]);
show("input undefined", () => new TextDecoder().decode(undefined));
show("input buffer", () => new TextDecoder().decode(new Uint8Array([104, 105]).buffer));

for (const options of [null, undefined, 1, "x", true, [], () => {}, { fatal: 1, ignoreBOM: "" }]) {
  show(`ctor ${typeof options}`, () => {
    const d = new TextDecoder("utf-8", options);
    return [d.encoding, d.fatal, d.ignoreBOM];
  });
  show(`decode ${typeof options}`, () => new TextDecoder().decode(new Uint8Array([65]), options));
}
show("order", () => new TextDecoder("nope", 1));
show("label", () => new TextDecoder("nope", null));
show("decode order", () => new TextDecoder().decode(false, 1));
const encoder = new TextEncoder();
show("encode undefined", () => [encoder.encode(undefined).length, new TextEncoder().encode(undefined).length, encoder.encode().length]);
// Symbol.toStringTag answers the class names.
const tagged = new TextDecoder();
console.log(tagged[Symbol.toStringTag], new TextEncoder()[Symbol.toStringTag]);
