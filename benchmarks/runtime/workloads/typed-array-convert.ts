// Element copies from one typed view into another, the way a codec moves
// pixel buffers: a view over a subarray copied into a freshly constructed
// view, then copies that convert, both by construction and through set()
// into a preallocated destination. Argument: the number of rounds.
const rounds = Number(process.argv[2] ?? "250");

const size = 1 << 17;
const bytes = new Uint8Array(size);
for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
const shorts = new Uint16Array(size);
for (let i = 0; i < size; i++) shorts[i] = (i * 37) & 0xffff;
const ints = new Int32Array(size);
for (let i = 0; i < size; i++) ints[i] = i * 37 - 1000;
const floats = new Float32Array(size);
for (let i = 0; i < size; i++) floats[i] = (i % 251) - 125.5;

const clamped = new Uint8ClampedArray(size);
const widened = new Uint16Array(size);
const narrowed = new Uint8Array(size);
const scaled = new Float32Array(size);

let total = 0;
for (let r = 0; r < rounds; r++) {
  // The Squoosh shape: a view over a subarray of the source, copied into a
  // new clamped view, then into a plain byte array.
  const view = bytes.subarray(r & 3);
  const copy = new Uint8ClampedArray(view);
  const raw = new Uint8Array(copy);
  const quantized = new Uint8ClampedArray(floats);
  clamped.set(bytes);
  widened.set(bytes);
  narrowed.set(shorts);
  scaled.set(ints);
  total = (total + raw[r & 7] + quantized[r & 9] + clamped[r & 15] + widened[r & 31] + narrowed[r & 63]) % 1000003;
}
console.log(total, clamped[9], widened[9], narrowed[9], scaled[9], floats[300]);
