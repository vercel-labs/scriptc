// A value typed `ArrayBufferView` is the library's common supertype of every
// typed array and DataView, so it stays the checked-dynamic value. Its three
// view reads answer from the native view the value actually holds (a typed
// array, a Buffer or a DataView; the buffer by identity) and otherwise from
// the dynamic tier, which is Node's own answer for a value that is not a
// view. Every other member stays dynamic.
const base = new ArrayBuffer(16);
const u8 = new Uint8Array(base, 2, 4);
u8.set([104, 101, 121, 33]);
const wide = new Float64Array(base, 8, 1);
const int16 = new Int16Array(3);
const dv = new DataView(base, 1, 6);
const buf = Buffer.from("buf");

function decode(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return null;
}

console.log(
  "decode",
  decode(new TextEncoder().encode("hey")),
  decode(u8),
  decode(wide),
  decode(dv),
  decode(buf),
  decode("plain"),
  decode(new ArrayBuffer(3)),
  decode(3),
  decode(null),
  decode(undefined),
  decode({}),
);

// The three reads answer every view kind. Reading them through the interface
// does not turn a Float64Array into bytes or vice versa.
function probe(label: string, value: ArrayBufferView): void {
  console.log(
    label,
    value.byteLength,
    value.byteOffset,
    ArrayBuffer.isView(value),
    (value.buffer as ArrayBuffer).byteLength,
  );
}
probe("u8", u8);
probe("f64", wide);
probe("i16", int16);
probe("dv", dv);
probe("sub", u8.subarray(1, 3));
console.log("buf", (buf as ArrayBufferView).byteLength, (buf as ArrayBufferView).buffer === buf.buffer);

// The buffer view is the same ArrayBuffer identity Node returns.
const asView = u8 as ArrayBufferView;
console.log(
  "identity",
  asView.buffer === u8.buffer,
  asView.buffer === base,
  (dv as ArrayBufferView).buffer === base,
  (buf as ArrayBufferView).buffer === buf.buffer,
  (u8.subarray(1) as ArrayBufferView).buffer === base,
);

// Building a view from the three reads touches the SAME bytes: the buffer is
// the backing store itself, not a copy.
const again = new Uint8Array(asView.buffer, asView.byteOffset, asView.byteLength);
again[1] = 111;
console.log("shared", new TextDecoder().decode(u8), u8[1], again !== u8, again.length);

// A narrowing by `ArrayBuffer.isView` supplies the interface type directly.
function lengths(data: unknown): string {
  if (!ArrayBuffer.isView(data)) return "not-a-view";
  return `${data.byteLength}@${data.byteOffset}`;
}
console.log(
  "narrowed",
  lengths(u8),
  lengths(wide),
  lengths(dv),
  lengths(new Uint16Array([1, 2, 3])),
  lengths(base),
  lengths("wow"),
);

// A value that is not a view answers Node's own property read: the interface
// is an abstraction, so a cast to it does not make the property exist.
const object = { byteLength: "seven", byteOffset: 1 } as unknown as ArrayBufferView;
console.log("object", object.byteLength, object.byteOffset, object.buffer);
const number = 5 as unknown as ArrayBufferView;
console.log("number", number.byteLength, number.byteOffset, number.buffer);
const nothing = null as unknown as ArrayBufferView;
try {
  console.log("nothing", nothing.byteLength);
} catch (error) {
  if (error instanceof TypeError) console.log("nothing threw", error.name);
}
const absent = {} as unknown as ArrayBufferView;
console.log("absent", absent.byteLength, absent.byteOffset, absent.buffer);

// A typed consumer reads the same three fields of every real view.
function needNumber(value: ArrayBufferView): number {
  return value.byteLength;
}
console.log("typed", needNumber(u8), needNumber(wide), needNumber(dv), needNumber(buf));

// Any other member access on the interface-typed value stays dynamic: the
// value's own members answer, exactly as in Node.
function extra(value: ArrayBufferView, key: string): unknown {
  return (value as unknown as Record<string, unknown>)[key];
}
console.log(
  "extra",
  extra(u8, "length"),
  extra(u8, "BYTES_PER_ELEMENT"),
  extra(wide, "BYTES_PER_ELEMENT"),
  extra(dv, "length"),
  extra(buf, "length"),
  extra(object, "byteLength"),
);
