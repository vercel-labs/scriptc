// Named properties on typed arrays, Buffers and DataViews (assignment,
// Object.defineProperty, reflection, deletion, integrity levels, JSON and
// inspection), and the Symbol.species constructor of map, filter, slice and
// subarray.
function box(value) {
  const holder = {};
  holder.value = value;
  return holder.value;
}

function expandos(TA) {
  const a = new TA([1, 2]);
  a.foo = 1;
  a.bar = "x";
  a[5] = 9;
  a["1.5"] = 7;
  console.log(a, a.foo, "foo" in a, a.hasOwnProperty("bar"), Object.keys(a), Object.entries(a).length);
  console.log(Object.getOwnPropertyNames(a), JSON.stringify(Object.getOwnPropertyDescriptor(a, "foo")), JSON.stringify(Object.getOwnPropertyDescriptor(a, "0")));
  Object.defineProperty(a, "hidden", { value: 3, enumerable: false });
  Object.defineProperty(a, "0", { value: 8 });
  console.log(a, a.hidden, Object.keys(a));
  try { Object.defineProperty(a, "1", { value: 1, configurable: false }); } catch (e) { console.log(e.constructor.name, e.message); }
  try { Object.defineProperty(a, "7", { value: 1 }); } catch (e) { console.log(e.constructor.name, e.message); }
  try { Object.defineProperty(a, "-0", { value: 1 }); } catch (e) { console.log(e.constructor.name, e.message); }
  try { Object.defineProperty(a, "0", { get() { return 1; } }); } catch (e) { console.log(e.constructor.name, e.message); }
  let reads = 0;
  Object.defineProperty(a, "g", { get() { reads++; return this.length; }, enumerable: true });
  console.log(a.g, reads, new TA(0));
  const e = new TA(0);
  e.k = { deep: [1] };
  console.log(e);
}

function species(TA, Other) {
  const s = new TA([1, 2, 3, 4]);
  const calls = [];
  s.constructor = {};
  s.constructor[Symbol.species] = function (n) { calls.push(n); return new Other(n); };
  const m = s.map((v) => v * 1.5), f = s.filter((v) => v > 1), sl = s.slice(1, 3);
  console.log(m, f, sl, calls);
  s.constructor[Symbol.species] = function (buffer, offset, length) { calls.push([offset, length]); return new TA(buffer, offset, length); };
  const sub = s.subarray(1, 3);
  sub[0] = 50;
  console.log(sub, s[1], calls.length);
  s.constructor[Symbol.species] = function () { return {}; };
  try { s.map((v) => v); } catch (err) { console.log(err.constructor.name); }
  s.constructor[Symbol.species] = function () { return new TA(1); };
  try { s.slice(); } catch (err) { console.log(err.constructor.name); }
  s.constructor = 5;
  try { s.filter(() => true); } catch (err) { console.log(err.constructor.name); }
  s.constructor = undefined;
  console.log(s.map((v) => v + 1));
  const t = new TA([3, 1]);
  Object.defineProperty(t, "constructor", { get() { calls.push("get"); return undefined; } });
  console.log(t.slice(), calls[calls.length - 1]);
  const u = new TA([1, 2, 3]);
  u.constructor = { [Symbol.species]: Uint16Array };
  console.log(u.filter(() => true), u.subarray(1), u.subarray(1).constructor === Uint16Array);
}

function reflection(TA) {
  const a = new TA([1, 2]);
  a.foo = 1;
  a[Symbol.for("s")] = 2;
  const keys = [];
  for (const k in a) keys.push(k);
  console.log(keys, { ...a }, JSON.stringify(a), Object.values(a));
  console.log(a.propertyIsEnumerable("foo"), Object.hasOwn(a, "foo"), Object.getOwnPropertySymbols(a), a[Symbol.for("s")]);
  console.log(Object.assign(new TA(2), { x: 1, 0: 9 }), Object.assign({}, a));
  delete a.foo;
  delete a[5];
  delete a.length;
  console.log(a, "foo" in a, a.length);
  try { delete a[0]; } catch (err) { console.log(err.message); }
  Object.defineProperty(a, "fixed", { value: 1 });
  try { delete a.fixed; } catch (err) { console.log(err.message); }
  try { a.fixed = 2; } catch (err) { console.log(err.message); }
  console.log(a.subarray(0, 1).fixed, a.slice().fixed);
  let seen;
  Object.defineProperty(a, "s", { set(v) { seen = [v, this === a]; } });
  a.s = 7;
  console.log(seen);
  a.map = 5;
  try { a.map((v) => v); } catch (err) { console.log(err.message); }
  for (const key of ["length", "byteLength", "byteOffset", "buffer"]) {
    try { a[key] = 1; } catch (err) { console.log(err.message); }
  }
  try { a[Symbol.toStringTag] = "x"; } catch (err) { console.log(err.message); }
  // Cycles through a view's own properties are collected.
  const loop = new TA(1);
  loop.self = loop;
  loop.size = () => loop.length;
  console.log(loop.self === loop, loop.size());
}

function integrity(TA) {
  const results = [];
  const attempt = (f) => { try { f(); results.push("ok"); } catch (err) { results.push(err.message); } };
  const sealed = new TA(1);
  sealed.x = 1;
  attempt(() => Object.seal(sealed));
  console.log(results, Object.isExtensible(sealed), Object.isSealed(sealed), JSON.stringify(Object.getOwnPropertyDescriptor(sealed, "x")));
  attempt(() => Object.seal(sealed));
  const frozen = new TA(1);
  frozen.x = 1;
  attempt(() => Object.freeze(frozen));
  attempt(() => Object.freeze(frozen));
  console.log(results, Object.isFrozen(frozen), JSON.stringify(Object.getOwnPropertyDescriptor(frozen, "x")));
  const closed = new TA(1);
  Object.defineProperty(closed, "q", { value: 1 });
  Object.preventExtensions(closed);
  try { closed.z = 1; } catch (err) { console.log(err.message); }
  try { closed[Symbol("n")] = 1; } catch (err) { console.log(err.message); }
  console.log(Object.isExtensible(closed), Object.isSealed(closed), Object.isFrozen(closed));
  const empty = new TA(0);
  empty.k = 1;
  Object.freeze(empty);
  try { empty.k = 2; } catch (err) { console.log(err.message); }
  console.log(Object.isFrozen(empty), Object.isSealed(empty), empty.k);
}

expandos(Uint8Array);
expandos(Float64Array);
species(Int16Array, Float32Array);
reflection(Uint8Array);
reflection(Int32Array);
integrity(Uint16Array);

const view = box(new DataView(new ArrayBuffer(2)));
view[0] = 5;
view.x = 1;
console.log(view, Object.keys(view), view[0], JSON.stringify(view), "0" in view);
try { view.byteLength = 1; } catch (err) { console.log(err.message); }
const buffer = box(Buffer.from([1, 2]));
buffer.foo = 1;
buffer[Symbol.for("k")] = 2;
console.log(buffer, Object.keys(buffer), JSON.stringify(buffer));
for (const key of ["parent", "offset", "length"]) {
  try { buffer[key] = 1; } catch (err) { console.log(err.message); }
}
const empty = box(Buffer.alloc(0));
empty.foo = { a: [1, { b: 2 }] };
console.log(empty);
