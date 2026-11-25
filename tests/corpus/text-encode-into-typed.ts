// TextEncoder.encodeInto over a statically typed string and Uint8Array: the
// operands are not boxed as dynamic values and the two counts come back in
// the { read, written } record the call site already expects. Every byte
// written is inspected so the typed walk and the checked-dynamic one agree
// on the exact edges, on each destination spelling, and on the operands a
// type-only wrapper leaves a union.
const encoder = new TextEncoder();

function fill255(length: number): Uint8Array {
  const backing = new Uint8Array(length);
  for (let i = 0; i < backing.length; i++) backing[i] = 255;
  return backing;
}

// Exact-fit, one-byte-short and empty destinations over multibyte text: an
// encodeInto that cannot take a whole code point stops before it.
for (const source of ["", "abc", "é", "€", "😀", "a😀é€Z", "héllo wörld"]) {
  for (let capacity = 0; capacity <= 12; capacity++) {
    const backing = fill255(capacity + 4);
    const destination = backing.subarray(2, 2 + capacity);
    const result = encoder.encodeInto(source, destination);
    console.log(JSON.stringify(source), capacity, result.read, result.written, Buffer.from(backing).toString("hex"));
  }
}

// The same call through a local binding, a class field and a closure: the
// receiver is evaluated (and its effects ordered) before the operands.
function encodeTwice(source: string, destination: Uint8Array): string {
  const first = encoder.encodeInto(source, destination);
  const second = encoder.encodeInto(source, destination);
  return first.read + "," + first.written + " " + second.read + "," + second.written;
}
const tail = fill255(10);
console.log(encodeTwice("café", tail.subarray(0, 5)), Buffer.from(tail).toString("hex"));

class CodecOwner {
  inner: TextEncoder = new TextEncoder();
  write(source: string, destination: Uint8Array): number {
    const result = this.inner.encodeInto(source, destination);
    return result.written * 100 + result.read;
  }
}
const owner = new CodecOwner();
const owned = new Uint8Array(6);
console.log(owner.write("€€€", owned), Buffer.from(owned).toString("hex"));
const captured = (source: string) => encoder.encodeInto(source, owned.subarray(1));
console.log(JSON.stringify(captured("A😀")), encoder.encoding, Buffer.from(owned).toString("hex"));

let order = "";
function receiver(): TextEncoder {
  order += "receiver;";
  return encoder;
}
function input(): string {
  order += "source;";
  return "é";
}
function output(): Uint8Array {
  order += "dest;";
  return owned;
}
const ordered = receiver().encodeInto(input(), output());
console.log(JSON.stringify(ordered), order, Buffer.from(owned).toString("hex"));

// A length-0 destination writes nothing even for a lone surrogate, and the
// read count still advances past it.
const zero = new Uint8Array(0);
const lone = encoder.encodeInto("\ud800x", zero);
console.log(lone.read, lone.written, zero.length);

// A destination a type-only wrapper presents as a Uint8Array still runs the
// runtime's own check: the cast does not change the value that arrives.
for (const wrong of [new Uint16Array(2), new Uint8ClampedArray(3)]) {
  try {
    encoder.encodeInto("x", wrong as unknown as Uint8Array);
  } catch (error) {
    if (error instanceof Error) console.log(error.name, (error as NodeJS.ErrnoException).code, error.message);
  }
}
