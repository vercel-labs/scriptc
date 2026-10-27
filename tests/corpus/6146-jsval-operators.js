// Dynamic-tier operators over jsval values: untyped JavaScript computes
// with NaN-boxed immediates, and every result keeps Node's semantics when
// it flows back into objects, arrays, calls and comparisons.
function dyn(value) {
  return value;
}

function show(label, value) {
  console.log(label, typeof value, Object.is(value, -0) ? "-0" : String(value));
}

function chain(a, b, c) {
  return (a * b + c) / (a - c) % 7;
}

var point = dyn({ x: 3, y: 4.5, z: -0, big: 2n ** 70n, nothing: null, missing: undefined, one: 1 });
show("chain", chain(point.x, point.y, 1));
show("chain-float", chain(0.1, 0.2, 0.3));
show("neg-zero", point.z * 1);
show("neg-zero-sum", point.z + -0);
show("neg-zero-mod", -4 % point.x + 1 - 1 === 0 ? -4 % 2 : 0);
show("nan", point.x * point.missing + 1);
show("inf", point.y / point.z);
show("pow", point.x ** 2 ** 2);
show("pow-edge", point.one ** (point.y / 0));
show("big", point.big * 3n + 1n);
show("big-div", point.big / 7n);
show("mixed-string", point.x + point.y + "!" + point.x * 2);
show("string-first", "n=" + point.x + point.y);
show("bool", true + point.x + point.nothing);
show("unary", -point.y + +"12" + ~point.x);
show("bitwise", (point.x | 8) ^ (point.y << 2) & 255);
show("shift", -1 >>> point.x);

// Results stored into dynamic containers and read back.
var bag = dyn({ total: 0, items: [] });
for (var i = 0; i < 5; i++) {
  bag.total = bag.total + i * point.y;
  bag.items.push(bag.total % 4, -i * 0);
}
console.log(bag.total, bag.items.join(","), Object.is(bag.items[1], -0));

// A local accumulator that only operators write.
function accumulate(o, n) {
  var acc = o.start;
  for (var k = 0; k < n; k++) acc = acc + o.step * k - 0.5;
  return acc;
}
show("acc", accumulate(dyn({ start: 10, step: 0.25 }), 100));
show("acc-string", accumulate(dyn({ start: "s", step: 2 }), 3));

// Strings and BigInts cross into the dynamic tier without a cell.
var texts = dyn({ name: "w", n: 3, big: 10n });
var label = texts.name;
for (var w = 0; w < 4; w++) label = label + "-" + w + (w % 2 === 0);
console.log(label, texts.name + undefined, texts.name + null, 1 + texts.n + "x");
console.log(texts.big + 5n, texts.big * -2n, 7n % texts.big, texts.big ** 3n, texts.big - texts.big);
try {
  console.log(texts.big / 0n);
} catch (error) {
  console.log(error instanceof RangeError, error.message);
}

// Increments and decrements of dynamic values.
var counters = dyn({ n: "5", b: 9007199254740993n, f: 1.5 });
counters.n++;
counters.b--;
counters.f += 1;
var post = counters.f++;
console.log(counters.n, counters.b, counters.f, post, typeof counters.n);

// Comparisons, including NaN and strings.
var cmp = dyn({ a: 2, b: "10", c: "9", nan: NaN });
console.log(cmp.a < cmp.b, cmp.b < cmp.c, cmp.a >= cmp.nan, cmp.nan <= cmp.nan);
console.log(cmp.a + 1 > cmp.c - 7, cmp.b * 1 <= cmp.c * 1, 3n > cmp.a, "a" < cmp.c);

// Truthiness of operator results.
var t = dyn({ a: 5, b: 5 });
if (t.a - t.b) console.log("nonzero");
else console.log("zero");
var countdown = t.a;
var seen = [];
while (countdown--) seen.push(countdown);
console.log(seen.join(" "), countdown);
console.log(t.a * 0 || "fallback", (t.a - 5) / 0 ? "nan-truthy" : "nan-falsy");

// ToPrimitive order: left before right, valueOf before toString.
var log = [];
function wrap(name, value) {
  return dyn({
    valueOf: function () {
      log.push(name + ".valueOf");
      return value;
    },
    toString: function () {
      log.push(name + ".toString");
      return "<" + name + ">";
    },
  });
}
var l = wrap("l", 3);
var r = wrap("r", 4);
console.log(l * r + l, l + "|" + r, l < r, l - r * 2);
console.log(log.join(" "));

// A throw in the middle of a chain leaves no partial state behind.
var bomb = dyn({
  valueOf: function () {
    throw new Error("boom");
  },
});
try {
  var partial = point.x * 2 + bomb * 3;
  console.log("unreachable", partial);
} catch (error) {
  console.log("caught", error.message);
}
try {
  console.log(point.big + point.x);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}
try {
  console.log(dyn(Symbol("s")) * point.x);
} catch (error) {
  console.log(error instanceof TypeError, error.message);
}

// A NaN with an arbitrary payload, read from a typed array, stays NaN.
var words = new Uint32Array([0xffffffff, 0xffffffff]);
var odd = dyn({ v: new Float64Array(words.buffer)[0] });
show("payload-nan", odd.v * 2 + 1);
console.log(odd.v + 1 === odd.v + 1, [odd.v + 1].includes(NaN));

// Async functions and generators compute with jsvals across suspensions.
async function asyncSum(o) {
  var t = 0;
  for (var i = 0; i < 3; i++) t = t + (await o.p) * i + o.q;
  return t;
}
function* steps(o) {
  var x = o.start;
  while (x < o.end) {
    yield x * 2;
    x = x + o.step;
  }
}
asyncSum(dyn({ p: 2, q: 0.25 })).then(function (v) {
  show("async", v);
});
console.log(Array.from(steps(dyn({ start: 1, end: 4, step: 1.5 }))).join(","));
