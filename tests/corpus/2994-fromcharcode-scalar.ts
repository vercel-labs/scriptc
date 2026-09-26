// The scalar path keeps ToUint16 wrapping and evaluates its input once.
let calls = 0;
function next(): number { calls++; return 64 + calls; }
console.log(String.fromCharCode(next()), calls);
console.log(String.fromCharCode(...[next()]), calls);

const values = [0, -0, 1, 65.9, -65.9, 127, 128, 255, 2047, 2048,
  0x2500, 0xD7FF, 0xD800, 0xDBFF, 0xDC00, 0xDFFF, 0xE000, 0xFFFF,
  65536, 65537, -1, -65537, NaN, Infinity, -Infinity, 2 ** 40 + 65];
for (const value of values) {
  const scalar = String.fromCharCode(value);
  const spread = String.fromCharCode(...[value]);
  const bytes = String.fromCharCode(...new Float64Array([value]));
  // Write lone surrogates as UTF-8 to exercise the runtime's documented
  // replacement policy without asserting unsupported internal surrogates.
  console.log(Buffer.from(scalar).toString("hex"), Buffer.from(spread).toString("hex"), Buffer.from(bytes).toString("hex"));
}

function fail(): number { throw new Error("argument failed"); }
try { console.log(String.fromCharCode(fail())); } catch (error) {
  console.log(error instanceof Error, calls);
}
console.log(String.fromCharCode(0xD83D, 0xDE00));

// Retaining earlier results must not expose cache mutation or stale pointers.
const held: string[] = [];
for (let i = 0; i < 192; i++) held.push(String.fromCharCode(0x2500 + i));
let total = 0;
for (let i = 0; i < held.length; i++) total += held[i]!.charCodeAt(0);
console.log(total, held[0], held[191]);
