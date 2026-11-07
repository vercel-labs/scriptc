// Every (source kind, destination kind) pair of the ten numeric typed-array
// kinds, converted three ways: new D(src), d.set(src, 1) and D.from(src). Each
// must store what Node stores, element for element. An integer source converts
// to an integer destination modulo the destination's width (the same bits
// whether the destination is signed or not), to Uint8ClampedArray by clamping
// to 0..255, and to a float destination exactly or by float rounding; a float
// source converts through ToUint32, or through the round-half-to-even clamp.
//
// The source values are the edges of every kind, one below and one above:
// -2^31, -2^16, -2^15, -2^8, -2^7, 2^7, 2^8, 2^15, 2^16, 2^31 and 2^32, with
// the halves a clamp rounds, -0, NaN, the infinities and values no integer
// kind holds. Constructing each source from them wraps, clamps or rounds them
// into that kind first, so every integer source also holds its own minimum
// and maximum.
//
// The blocks below are mechanical: one function per source kind, one block
// per destination kind inside it, in kind order.
const V: number[] = [
  -2147483649, -2147483648, -2147483647, -65537, -65536, -65535, -32769, -32768, -32767,
  -257, -256, -255, -129, -128, -127, -2, -1, -0.5, -0, 0, 5e-324, 0.49999999999999994, 0.5,
  0.5000000000000001, 1, 1.5, 2, 2.5, 126, 127, 127.5, 128, 128.5, 129, 254, 254.5, 255,
  255.5, 256, 257, 32767, 32768, 32769, 65535, 65536, 65537, 2147483647, 2147483648,
  2147483649, 4294967295, 4294967296, 4294967297, 1e21, -1e21, NaN, Infinity, -Infinity,
];
const N = V.length;

function hex(b: ArrayBuffer, byteOffset: number, byteLength: number): string {
  return Buffer.from(new Uint8Array(b, byteOffset, byteLength)).toString("hex");
}

function row(pair: string, made: string, set: string, from: string): void {
  console.log(pair, made);
  // set() wrote at element 1 of a zeroed destination two elements longer.
  const width = (set.length - made.length) / 4;
  const middle = set.slice(width * 2, set.length - width * 2);
  console.log(pair, "set", middle === made, set.slice(0, width * 2), set.slice(set.length - width * 2));
  console.log(pair, "from", from === made);
}

// ── Uint8Array source ──────────────────────────────────────────────────
function fromUint8Array(): void {
  const src = new Uint8Array(V);
  console.log("src u8", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-u8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromUint8Array();

// ── Uint8ClampedArray source ───────────────────────────────────────────
function fromUint8ClampedArray(): void {
  const src = new Uint8ClampedArray(V);
  console.log("src u8c", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-u8c", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromUint8ClampedArray();

// ── Int8Array source ───────────────────────────────────────────────────
function fromInt8Array(): void {
  const src = new Int8Array(V);
  console.log("src i8", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-i8", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromInt8Array();

// ── Uint16Array source ─────────────────────────────────────────────────
function fromUint16Array(): void {
  const src = new Uint16Array(V);
  console.log("src u16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-u16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromUint16Array();

// ── Int16Array source ──────────────────────────────────────────────────
function fromInt16Array(): void {
  const src = new Int16Array(V);
  console.log("src i16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-i16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromInt16Array();

// ── Uint32Array source ─────────────────────────────────────────────────
function fromUint32Array(): void {
  const src = new Uint32Array(V);
  console.log("src u32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-u32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromUint32Array();

// ── Int32Array source ──────────────────────────────────────────────────
function fromInt32Array(): void {
  const src = new Int32Array(V);
  console.log("src i32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-i32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromInt32Array();

// ── Float16Array source ────────────────────────────────────────────────
function fromFloat16Array(): void {
  const src = new Float16Array(V);
  console.log("src f16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-f16", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromFloat16Array();

// ── Float32Array source ────────────────────────────────────────────────
function fromFloat32Array(): void {
  const src = new Float32Array(V);
  console.log("src f32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-f32", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromFloat32Array();

// ── Float64Array source ────────────────────────────────────────────────
function fromFloat64Array(): void {
  const src = new Float64Array(V);
  console.log("src f64", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  {
    const made = new Uint8Array(src), from = Uint8Array.from(src), set = new Uint8Array(N + 2);
    set.set(src, 1);
    row("u8<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint8ClampedArray(src), from = Uint8ClampedArray.from(src), set = new Uint8ClampedArray(N + 2);
    set.set(src, 1);
    row("u8c<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int8Array(src), from = Int8Array.from(src), set = new Int8Array(N + 2);
    set.set(src, 1);
    row("i8<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint16Array(src), from = Uint16Array.from(src), set = new Uint16Array(N + 2);
    set.set(src, 1);
    row("u16<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int16Array(src), from = Int16Array.from(src), set = new Int16Array(N + 2);
    set.set(src, 1);
    row("i16<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Uint32Array(src), from = Uint32Array.from(src), set = new Uint32Array(N + 2);
    set.set(src, 1);
    row("u32<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Int32Array(src), from = Int32Array.from(src), set = new Int32Array(N + 2);
    set.set(src, 1);
    row("i32<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float16Array(src), from = Float16Array.from(src), set = new Float16Array(N + 2);
    set.set(src, 1);
    row("f16<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float32Array(src), from = Float32Array.from(src), set = new Float32Array(N + 2);
    set.set(src, 1);
    row("f32<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
  {
    const made = new Float64Array(src), from = Float64Array.from(src), set = new Float64Array(N + 2);
    set.set(src, 1);
    row("f64<-f64", hex(made.buffer as ArrayBuffer, made.byteOffset, made.byteLength), hex(set.buffer as ArrayBuffer, set.byteOffset, set.byteLength), hex(from.buffer as ArrayBuffer, from.byteOffset, from.byteLength));
  }
}
fromFloat64Array();
