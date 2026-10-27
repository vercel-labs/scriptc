// Object literals built in untyped functions, many times through the same
// sites: key order (integer-like keys first), members named
// like Object.prototype members and Error fields, __proto__ members, wide
// literals, literals that differ only in a later member, and objects
// changed after they are built.
function point(x, y) {
  return { x, y, label: "p" + x };
}
function ordered(i) {
  return { b: i, 2: "two", a: i + 1, 1: "one", "01": "zero-one" };
}
function named(i) {
  return { constructor: i, toString: "s" + i, message: "m" + i, name: "n" + i, code: i, stack: "st" };
}
function withProto(proto, i) {
  if (proto === null) return { __proto__: null, own: i };
  const o = { own: i };
  Object.setPrototypeOf(o, proto);
  return o;
}
function wide(i) {
  return {
    k0: i, k1: i, k2: i, k3: i, k4: i, k5: i, k6: i, k7: i, k8: i, k9: i,
    k10: i, k11: i, k12: i, k13: i, k14: i, k15: i, k16: i, k17: i, k18: i, k19: i,
    k20: i, k21: i, k22: i, k23: i, k24: i, k25: i, k26: i, k27: i, k28: i, k29: i,
    k30: i, k31: i, k32: i, k33: i, k34: i, k35: i, k36: i, k37: i, k38: i, k39: i,
    k40: i, k41: i, k42: i, k43: i, k44: i, k45: i, k46: i, k47: i, k48: i, k49: i,
    k50: i, k51: i, k52: i, k53: i, k54: i, k55: i, k56: i, k57: i, k58: i, k59: i,
    k60: i, k61: i, k62: i, k63: i, k64: i, k65: i, k66: i, k67: i, k68: i, k69: i,
  };
}
function variant(i) {
  const head = { kind: "v", n: i };
  return i % 2 ? { ...head, odd: true } : { ...head, even: true, n: -i };
}

let sum = 0;
const points = [];
for (let i = 0; i < 2000; i++) {
  const p = point(i, i * 2);
  sum += p.x + p.y;
  if (i % 500 === 0) points.push(p);
}
points[0].z = 9;
delete points[1].label;
console.log(sum, JSON.stringify(points), Object.keys(points[2]).join());

const o = [ordered(1), ordered(2)];
console.log(Object.keys(o[1]).join(), JSON.stringify(o[0]), o[1]["01"], o[1][1]);

const n = [named(1), named(2)];
console.log(JSON.stringify(n[1]), typeof n[0].toString, n[1].constructor, n[1] instanceof Error);

const proto = { greet() { return "hi " + this.own; } };
const w = [withProto(proto, 1), withProto(proto, 2), withProto(null, 3)];
console.log(w[1].greet(), Object.getPrototypeOf(w[0]) === proto, Object.getPrototypeOf(w[2]), Object.keys(w[1]).join());

let wideSum = 0;
for (let i = 0; i < 50; i++) {
  const big = wide(i);
  wideSum += big.k0 + big.k69;
}
console.log(wideSum, Object.keys(wide(1)).length, Object.keys(wide(2))[69]);

const v = [];
for (let i = 0; i < 6; i++) v.push(variant(i));
console.log(JSON.stringify(v));
