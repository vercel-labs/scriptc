// set() from a typed view whose storage overlaps the destination: Node clones
// the source bytes before converting, so every case below depends on the
// snapshot (or, for bit-compatible element kinds, on an in-place byte move
// that yields the same result). Covers same-kind moves, equal-width kinds
// whose bits carry over, narrowing and widening conversions across view
// boundaries, unaligned views, and shared storage.
function pattern(n: number): Uint8Array {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 7 + 3) & 0xff;
  return u;
}

function hex(u: Uint8Array): string {
  return Buffer.from(u).toString("hex");
}

// ── one buffer, two views; the move runs inside the buffer ──────────────
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u16 = new Uint16Array(ab);
  u16.set(u16.subarray(1), 0);
  console.log("u16 same-kind right", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u16 = new Uint16Array(ab);
  u16.set(u16.subarray(0, 8), 3);
  console.log("u16 same-kind left", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u16 = new Uint16Array(ab);
  const i16 = new Int16Array(ab);
  i16.set(u16.subarray(2));
  console.log("i16.set.u16 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u8 = new Uint8Array(ab, 0, 24);
  const u8c = new Uint8ClampedArray(ab, 6, 20);
  u8c.set(u8.subarray(1, 21));
  console.log("u8c.set.u8 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u8 = new Uint8Array(ab);
  const i8 = new Int8Array(ab, 4, 20);
  i8.set(u8.subarray(2, 22));
  console.log("i8.set.u8 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u8 = new Uint8Array(ab);
  const u16 = new Uint16Array(ab, 2, 12);
  u8.set(u16.subarray(1), 1);
  console.log("u8.set.u16 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const u16 = new Uint16Array(ab, 0, 12);
  const u8 = new Uint8Array(ab, 2, 20);
  u16.set(u8.subarray(1, 12), 1);
  console.log("u16.set.u8 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const f32 = new Float32Array(ab, 0, 6);
  const u8 = new Uint8Array(ab, 3, 20);
  u8.set(f32.subarray(1, 5));
  console.log("u8.set.f32 overlapping", hex(all));
}
{
  const ab = new ArrayBuffer(32);
  const all = new Uint8Array(ab);
  all.set(pattern(32));
  const f32 = new Float32Array(ab, 4, 5);
  const u16 = new Uint16Array(ab);
  f32.set(u16.subarray(2, 6), 1);
  console.log("f32.set.u16 overlapping", hex(all));
}
// Views at offsets other than zero: one-byte views may start anywhere, and a
// two-byte view starts at an even offset inside the one-byte source.
{
  const ab = new ArrayBuffer(33);
  const all = new Uint8Array(ab);
  all.set(pattern(33));
  const u8c = new Uint8ClampedArray(ab, 1, 24);
  const i8 = new Int8Array(ab, 3, 20);
  u8c.set(i8.subarray(1));
  console.log("u8c.set.i8 odd offset", hex(all));
}
{
  const ab = new ArrayBuffer(33);
  const all = new Uint8Array(ab);
  all.set(pattern(33));
  const u16 = new Uint16Array(ab, 2, 12);
  const u8c = new Uint8ClampedArray(ab, 3, 20);
  u8c.set(u16.subarray(1));
  console.log("u8c.set.u16 even offset", hex(all));
}

// ── shared storage takes the same snapshot ──────────────────────────────
{
  const sab = new SharedArrayBuffer(32);
  const all = new Uint8Array(sab);
  all.set(pattern(32));
  const u16 = new Uint16Array(sab);
  const i16 = new Int16Array(sab);
  i16.set(u16.subarray(1));
  console.log("shared i16.set.u16", hex(all));
}
{
  const sab = new SharedArrayBuffer(32);
  const all = new Uint8Array(sab);
  all.set(pattern(32));
  const u8 = new Uint8Array(sab, 0, 24);
  const u8c = new Uint8ClampedArray(sab, 4, 20);
  u8c.set(u8.subarray(1, 21));
  console.log("shared u8c.set.u8", hex(all));
}
{
  const sab = new SharedArrayBuffer(32);
  const all = new Uint8Array(sab);
  all.set(pattern(32));
  const u8 = new Uint8Array(sab);
  const u16 = new Uint16Array(sab, 2, 12);
  u8.set(u16.subarray(1), 1);
  console.log("shared u8.set.u16", hex(all));
}
{
  const sab = new SharedArrayBuffer(32);
  const all = new Uint8Array(sab);
  all.set(pattern(32));
  const f32 = new Float32Array(sab, 0, 6);
  const u8 = new Uint8Array(sab, 3, 20);
  u8.set(f32.subarray(1, 5));
  console.log("shared u8.set.f32", hex(all));
}

// ── a private source into a shared destination and back ─────────────────
{
  const sab = new SharedArrayBuffer(16);
  const all = new Uint8Array(sab);
  all.set(pattern(16));
  const shared = new Uint16Array(sab);
  const private_ = new Uint8Array(pattern(16));
  shared.set(new Uint16Array(private_.buffer));
  console.log("shared set private", hex(all));
  const back = new Uint8Array(new Uint16Array(sab));
  console.log("private from shared", hex(back));
}
