// Element copies across typed-array kinds: constructing a typed array from a
// typed view, and set() from one, convert every element. The result must
// match Node's per-element conversion (ToNumber, ToUint32 truncated to the
// destination width, Uint8ClampedArray's round-half-to-even clamp, float
// rounding) for every kind pair, including the pairs whose element bits stay
// the same and the ones that only keep them in one direction. Values cross
// each truncation and clamping edge: -1, halves, 255/256, 65535/65536,
// 2^31, 2^32-1/2^32, -0, NaN, infinities.
const V: number[] = [
  -1, 0, -0, 0.5, 1.5, 2.5, 127.5, 128.5, 200, 255, 255.5, 256, 300, 65535, 65536,
  70000, 2147483648, 4294967295, 4294967296, NaN, Infinity, -Infinity, 1e21, -1e21,
];

function hex(b: ArrayBuffer, byteOffset: number, byteLength: number): string {
  return Buffer.from(new Uint8Array(b, byteOffset, byteLength)).toString("hex");
}

const N = V.length;

// ── Uint8Array source ───────────────────────────────────────────────────
{
  const src = new Uint8Array(V);
  console.log("src u8", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8Array(src);
  console.log("u8<-u8", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint8ClampedArray(src);
  console.log("u8c<-u8", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Int8Array(src);
  console.log("i8<-u8", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Uint16Array(src);
  console.log("u16<-u8", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
  const e = new Int16Array(src);
  console.log("i16<-u8", hex(e.buffer as ArrayBuffer, e.byteOffset, e.byteLength));
  const f = new Uint32Array(src);
  console.log("u32<-u8", hex(f.buffer as ArrayBuffer, f.byteOffset, f.byteLength));
  const g = new Int32Array(src);
  console.log("i32<-u8", hex(g.buffer as ArrayBuffer, g.byteOffset, g.byteLength));
  const h = new Float32Array(src);
  console.log("f32<-u8", hex(h.buffer as ArrayBuffer, h.byteOffset, h.byteLength));
  const i = new Float64Array(src);
  console.log("f64<-u8", hex(i.buffer as ArrayBuffer, i.byteOffset, i.byteLength));
  const j = new Float16Array(src);
  console.log("f16<-u8", hex(j.buffer as ArrayBuffer, j.byteOffset, j.byteLength));
}

// ── Uint8ClampedArray source ────────────────────────────────────────────
{
  const src = new Uint8ClampedArray(V);
  console.log("src u8c", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8Array(src);
  console.log("u8<-u8c", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Int8Array(src);
  console.log("i8<-u8c", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Uint16Array(src);
  console.log("u16<-u8c", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float32Array(src);
  console.log("f32<-u8c", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
  const e = new Uint8ClampedArray(src);
  console.log("u8c<-u8c", hex(e.buffer as ArrayBuffer, e.byteOffset, e.byteLength));
}

// ── Int8Array source: the one same-width kind a clamped destination cannot
// copy, because -1 clamps to 0 and is 0xFF as bits.
{
  const src = new Int8Array(V);
  console.log("src i8", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8ClampedArray(src);
  console.log("u8c<-i8", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint8Array(src);
  console.log("u8<-i8", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Uint16Array(src);
  console.log("u16<-i8", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float64Array(src);
  console.log("f64<-i8", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
}

// ── Uint16Array and Int16Array sources ──────────────────────────────────
{
  const src = new Uint16Array(V);
  console.log("src u16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8Array(src);
  console.log("u8<-u16", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint8ClampedArray(src);
  console.log("u8c<-u16", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Int32Array(src);
  console.log("i32<-u16", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float16Array(src);
  console.log("f16<-u16", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
}
{
  const src = new Int16Array(V);
  console.log("src i16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8ClampedArray(src);
  console.log("u8c<-i16", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint32Array(src);
  console.log("u32<-i16", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Int16Array(src);
  console.log("i16<-i16", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
}

// ── Uint32Array and Int32Array sources ──────────────────────────────────
{
  const src = new Uint32Array(V);
  console.log("src u32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8Array(src);
  console.log("u8<-u32", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint8ClampedArray(src);
  console.log("u8c<-u32", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Uint16Array(src);
  console.log("u16<-u32", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float64Array(src);
  console.log("f64<-u32", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
}
{
  const src = new Int32Array(V);
  console.log("src i32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8ClampedArray(src);
  console.log("u8c<-i32", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Int8Array(src);
  console.log("i8<-i32", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Float32Array(src);
  console.log("f32<-i32", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
}

// ── same-width integer pairs, which copy the element bits ───────────────
{
  const i8 = new Int8Array(V);
  console.log("i8<-i8", hex(i8.buffer as ArrayBuffer, i8.byteOffset, i8.byteLength));
  const u16 = new Uint16Array(V);
  const u16FromI16 = new Uint16Array(new Int16Array(V));
  console.log("u16<-i16", hex(u16FromI16.buffer as ArrayBuffer, u16FromI16.byteOffset, u16FromI16.byteLength));
  const i16FromU16 = new Int16Array(u16);
  console.log("i16<-u16", hex(i16FromU16.buffer as ArrayBuffer, i16FromU16.byteOffset, i16FromU16.byteLength));
  const sameU16 = new Uint16Array(u16);
  console.log("u16<-u16", hex(sameU16.buffer as ArrayBuffer, sameU16.byteOffset, sameU16.byteLength));
  const u32 = new Uint32Array(V);
  const u32FromI32 = new Uint32Array(new Int32Array(V));
  console.log("u32<-i32", hex(u32FromI32.buffer as ArrayBuffer, u32FromI32.byteOffset, u32FromI32.byteLength));
  const i32FromU32 = new Int32Array(u32);
  console.log("i32<-u32", hex(i32FromU32.buffer as ArrayBuffer, i32FromU32.byteOffset, i32FromU32.byteLength));
  const sameU32 = new Uint32Array(u32);
  console.log("u32<-u32", hex(sameU32.buffer as ArrayBuffer, sameU32.byteOffset, sameU32.byteLength));
  const u32FromI32Again = new Uint32Array(i32FromU32);
  console.log("u32<-i32 again", hex(u32FromI32Again.buffer as ArrayBuffer, u32FromI32Again.byteOffset, u32FromI32Again.byteLength));
}

// ── Float32Array source ─────────────────────────────────────────────────
{
  const src = new Float32Array(V);
  console.log("src f32", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8Array(src);
  console.log("u8<-f32", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Uint8ClampedArray(src);
  console.log("u8c<-f32", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Int32Array(src);
  console.log("i32<-f32", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float16Array(src);
  console.log("f16<-f32", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
  const e = new Float64Array(src);
  console.log("f64<-f32", hex(e.buffer as ArrayBuffer, e.byteOffset, e.byteLength));
}

// ── Float64Array source ─────────────────────────────────────────────────
{
  const src = new Float64Array(V);
  console.log("src f64", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8ClampedArray(src);
  console.log("u8c<-f64", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Int16Array(src);
  console.log("i16<-f64", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Float32Array(src);
  console.log("f32<-f64", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Float16Array(src);
  console.log("f16<-f64", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
  const e = new Float64Array(src);
  console.log("f64<-f64", hex(e.buffer as ArrayBuffer, e.byteOffset, e.byteLength));
}

// ── Float16Array source ─────────────────────────────────────────────────
{
  const src = new Float16Array(V);
  console.log("src f16", hex(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength));
  const a = new Uint8ClampedArray(src);
  console.log("u8c<-f16", hex(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength));
  const b = new Float32Array(src);
  console.log("f32<-f16", hex(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength));
  const c = new Float64Array(src);
  console.log("f64<-f16", hex(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength));
  const d = new Uint16Array(src);
  console.log("u16<-f16", hex(d.buffer as ArrayBuffer, d.byteOffset, d.byteLength));
}

// ── set() from a typed view must agree with construction ────────────────
{
  const src = new Uint8Array(V);
  const dst = new Uint8ClampedArray(N);
  dst.set(src, 0);
  console.log("u8c.set.u8", hex(dst.buffer as ArrayBuffer, dst.byteOffset, dst.byteLength));
  const f32 = new Float32Array(24);
  f32.set(new Uint8Array(V), 0);
  console.log("f32.set.u8", hex(f32.buffer as ArrayBuffer, f32.byteOffset, f32.byteLength));
  const i16 = new Int16Array(24);
  i16.set(new Uint16Array(V), 0);
  console.log("i16.set.u16", hex(i16.buffer as ArrayBuffer, i16.byteOffset, i16.byteLength));
  const u8 = new Uint8Array(24);
  u8.set(new Float32Array(V), 0);
  console.log("u8.set.f32", hex(u8.buffer as ArrayBuffer, u8.byteOffset, u8.byteLength));
  const u8c = new Uint8ClampedArray(24);
  u8c.set(new Int8Array(V), 0);
  console.log("u8c.set.i8", hex(u8c.buffer as ArrayBuffer, u8c.byteOffset, u8c.byteLength));
  const f64 = new Float64Array(24);
  f64.set(new Int32Array(V), 0);
  console.log("f64.set.i32", hex(f64.buffer as ArrayBuffer, f64.byteOffset, f64.byteLength));
}

// ── from() takes the same conversion ────────────────────────────────────
{
  const src = new Uint8Array(V);
  const fromU8C = Uint8ClampedArray.from(src);
  console.log("from u8c", hex(fromU8C.buffer as ArrayBuffer, fromU8C.byteOffset, fromU8C.byteLength));
  const fromI16 = Int16Array.from(new Int8Array(V));
  console.log("from i16", hex(fromI16.buffer as ArrayBuffer, fromI16.byteOffset, fromI16.byteLength));
}
