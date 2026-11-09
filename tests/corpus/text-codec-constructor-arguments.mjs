// new TextEncoder(label) ignores its arguments after evaluating them, and
// new TextDecoder(label, options) honours the label, fatal and ignoreBOM.
const order = [];
const mark = (value) => (order.push(String(value)), value);

const encoder = new TextEncoder("utf-8");
const strict = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
const loose = new TextDecoder("utf-8", { ignoreBOM: false, fatal: false });
strict.decode();
console.log(encoder.encoding, strict.encoding, strict.fatal, strict.ignoreBOM);
console.log(loose.encoding, loose.fatal, loose.ignoreBOM);

const bytes = encoder.encode("\uFEFFh\u00E9");
console.log(Array.from(bytes).join(","));
console.log(JSON.stringify(strict.decode(bytes)), JSON.stringify(loose.decode(bytes)));
const bad = new Uint8Array([0x61, 0xff, 0x62, 0xc3]);
console.log(JSON.stringify(loose.decode(bad)));
try {
  strict.decode(bad);
} catch (error) {
  console.log(error.name, error.code, error.message);
}

const other = new TextEncoder(mark("utf-16le"), mark({ fatal: true }));
console.log(other.encoding, Array.from(other.encode("\u20AC")).join(","), order.join("|"));
console.log(Array.from(new TextEncoder(mark("latin1")).encode(mark("\u00FF"))).join(","), order.join("|"));
const literal = new TextEncoder("utf-16le", { bogus: 1, fatal: mark("fatal") });
console.log(
  literal.encoding,
  Array.from(new TextEncoder(1, 2, mark(3)).encode("\u00E9")).join(","),
  order.join("|"),
);
const view = new Uint8Array(4);
console.log(
  JSON.stringify(new TextEncoder(undefined).encodeInto("h\u00E9llo", view)),
  Array.from(view).join(","),
);
const glueEncoder =
  typeof TextEncoder !== "undefined"
    ? new TextEncoder("utf-8")
    : {
        encode: () => {
          throw Error("TextEncoder not available");
        },
      };
console.log(Array.from(glueEncoder.encode("ok")).join(","));

for (const label of [
  "utf-8",
  "utf8",
  "UTF-8",
  " unicode-1-1-utf-8\n",
  "unicode11utf8",
  "unicode20utf8",
  "x-unicode20utf8",
  "latin1",
  "utf-16le",
]) {
  const decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  console.log(JSON.stringify(label), decoder.encoding, decoder.fatal, decoder.ignoreBOM);
}
for (const label of ["utf-9", "", "utf-32", "replacement", "\u00A0utf-8"]) {
  try {
    new TextDecoder(label, { ignoreBOM: true, fatal: true });
    console.log("no error", JSON.stringify(label));
  } catch (error) {
    console.log(error instanceof RangeError, error.name, error.code, error.message);
  }
}

const labels = ["utf-8", "UTF8", "nope"];
const options = [{ fatal: true }, { ignoreBOM: true }, {}];
for (let i = 0; i < labels.length; i++) {
  try {
    const decoder = new TextDecoder(labels[i], options[i]);
    const text = decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x80]));
    console.log(decoder.encoding, decoder.fatal, decoder.ignoreBOM, JSON.stringify(text));
  } catch (error) {
    console.log(error.name, error.code, error.message);
  }
}

const streaming = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
let out = "";
for (const chunk of [[0xef], [0xbb, 0xbf, 0xe2], [0x82, 0xac]])
  out += streaming.decode(new Uint8Array(chunk), { stream: true });
out += streaming.decode();
console.log(JSON.stringify(out));
try {
  streaming.decode(new Uint8Array([0xe2, 0x82]));
} catch (error) {
  console.log(error.name, error.code);
}

const spreadOrder = [];
function* spreadLabels() {
  spreadOrder.push("start");
  yield "utf-8";
  spreadOrder.push("next");
  yield "x";
  spreadOrder.push("done");
}
const spread = new TextEncoder(...spreadLabels(), ...["a", "b"]);
console.log(spread.encoding, Array.from(spread.encode("\u00E9")).join(","), spreadOrder.join("|"));
console.log(new TextEncoder(...[]).encode("z").length);
for (const notIterable of [null, undefined, 5, {}]) {
  try {
    new TextEncoder(...notIterable);
  } catch (error) {
    console.log(error.name, error.message);
  }
}
