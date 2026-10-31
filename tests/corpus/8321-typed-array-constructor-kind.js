// A built-in typed-array constructor set as a view's `constructor` is the
// species of map, filter, slice and subarray when the program never names
// the species symbol.
function kinds(TA, Other) {
  const a = new TA([1, 2, 3, 4]);
  a.constructor = Other;
  const m = a.map((v) => v * 1.5), f = a.filter((v) => v > 1), s = a.slice(1, 3);
  console.log(m, f, s, m.constructor === Other, f.constructor === Other, s.constructor === Other);
  try {
    const sub = a.subarray(0, 2);
    console.log(sub, sub.constructor === Other);
  } catch (err) {
    console.log(err.constructor.name);
  }
  a.constructor = TA;
  console.log(a.map((v) => v / 2).constructor === TA);
  a.constructor = {};
  console.log(a.slice().constructor === TA);
}
kinds(Uint8Array, Float64Array);
kinds(Int16Array, Uint8Array);
kinds(Float32Array, Int32Array);
kinds(Float64Array, Uint8ClampedArray);
