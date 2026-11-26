// TextEncoder/TextDecoder: WebIDL argument and option conversions, the UTF-8
// encoder's lone-surrogate replacement, encodeInto's counts, decode's BOM
// handling and invalid sequences, fatal mode, streaming (a stored decoder
// and a fresh inline one), encoding labels, non-bytes inputs, and the
// surplus arguments Node evaluates and ignores.
const encoder = new TextEncoder();
console.log("encoding", encoder.encoding);
console.log("bytes", [...encoder.encode("héllo")].join(","));
console.log("empty", encoder.encode().length);
console.log("lone surrogate", [...encoder.encode("a\uD800b")].join(","));
console.log("number", [...encoder.encode(42)].join(","));
console.log("null", [...encoder.encode(null)].join(","));
console.log("object", [...encoder.encode({ toString: () => "hi" })].join(","));
console.log("array", [...encoder.encode(["a", "b"])].join(","));
console.log("surplus", [...encoder.encode("ab", 1, 2)].join(","));

const target = new Uint8Array(4);
const into = encoder.encodeInto("héllo", target);
console.log("encodeInto", into.read, into.written, [...target].join(","));
const small = encoder.encodeInto("ab", new Uint8Array(1));
console.log("encodeInto small", small.read, small.written);

const decoder = new TextDecoder();
console.log("decoder", decoder.encoding, decoder.fatal, decoder.ignoreBOM);
console.log(
  "decode",
  JSON.stringify(decoder.decode(new Uint8Array([104, 105]))),
  JSON.stringify(decoder.decode()),
);
console.log("bom", JSON.stringify(decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68]))));
console.log(
  "ignoreBOM",
  JSON.stringify(
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68])),
  ),
);
console.log("invalid", JSON.stringify(decoder.decode(new Uint8Array([0xff, 0xfe]))));
try {
  new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]));
} catch (caught) {
  console.log("fatal", caught.constructor.name, caught.code, JSON.stringify(caught.message));
}
try {
  new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff]), { stream: true });
} catch (caught) {
  console.log("fatal stream", caught.constructor.name, caught.code);
}
const streaming = new TextDecoder();
console.log(
  "stream",
  JSON.stringify(streaming.decode(new Uint8Array([0xe2, 0x9c]), { stream: true })),
  JSON.stringify(streaming.decode(new Uint8Array([0x93]), { stream: true })),
  JSON.stringify(streaming.decode()),
);
console.log(
  "inline stream",
  JSON.stringify(new TextDecoder().decode(new Uint8Array([0xe2]), { stream: true })),
);
console.log(
  "stream truthy",
  JSON.stringify(decoder.decode(new Uint8Array([0xe2, 0x9c, 0x93]), { stream: "yes" })),
);
console.log(
  "flag truthy",
  new TextDecoder("utf-8", { fatal: 1 }).fatal,
  new TextDecoder("utf-8", { fatal: 0 }).fatal,
  new TextDecoder("utf-8", { ignoreBOM: "x" }).ignoreBOM,
);
try {
  new TextDecoder("bogus");
} catch (caught) {
  console.log("label", caught.constructor.name, caught.code, JSON.stringify(caught.message));
}
try {
  decoder.decode("hi");
} catch (caught) {
  console.log("non-bytes", caught.constructor.name, caught.code, JSON.stringify(caught.message));
}
console.log("undefined", JSON.stringify(decoder.decode(undefined)));
console.log(
  "surplus",
  JSON.stringify(decoder.decode(new Uint8Array([0x68]), { stream: false }, 1, 2)),
);
