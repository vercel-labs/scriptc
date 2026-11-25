// A store that is a member of an object guard group writes through the
// group's entry: the guard has established that the subject is an ordinary
// layout-mode object whose layout holds the key, so the store replaces an
// existing slot and the shape stays. A number replaces the value of an
// unshared number cell in place; any other value is boxed and the slot takes
// the new cell. Every receiver the guard refuses (dictionary mode, frozen,
// a prototype key, other kinds) must still store exactly as its own site's
// helper does.
//
// The subjects come from JSON.parse, so nothing types them and the stores
// are dynamic-tier property access.

function fresh(text) {
  return JSON.parse(text);
}

function field(o, key) {
  return o[key];
}

// A number replaces an unshared number cell in place, and the reads after
// the store see it.
function setQty(o, v) {
  o.qty = v;
  return o.qty + o.price;
}
const doc = fresh('{"qty":1,"price":2,"meta":{"tag":3}}');
console.log("inplace", setQty(doc, 5), field(doc, "qty"), field(doc, "price"));
console.log("inplacejson", JSON.stringify(doc));

// The slot holds a string: the store boxes a new cell and releases the old.
function setLabel(o, v) {
  o.label = v;
  return o.label + o.price;
}
const labelled = fresh('{"label":"a","price":4}');
console.log("string", setLabel(labelled, "b"), field(labelled, "label"));
console.log("stringjson", JSON.stringify(labelled));

// A number cell two slots share must not be updated in place.
function share(a, b) {
  b.qty = a.qty;
  return b.qty;
}
function bump(o, v) {
  o.qty = v;
  return o.qty + o.price;
}
const one = fresh('{"qty":5,"price":1}');
const two = fresh('{"qty":5,"price":1}');
share(one, two);
console.log("shared", bump(one, 7), field(one, "qty"), field(two, "qty"));

// Key orders, an extra key, and a key order the layout meets for the first
// time.
function update(o, v) {
  o.q = v;
  return o.p + o.q;
}
for (const text of ['{"p":1,"q":2}', '{"q":2,"p":1}', '{"p":1,"q":2,"r":3}', '{"r":3,"p":1,"q":2}']) {
  const o = fresh(text);
  console.log("shape", update(o, 4), field(o, "q"), JSON.stringify(o));
}

// Every kind of value through one grouped site.
function mixed(o) {
  o.a = 1;
  o.b = true;
  o.c = "s";
  o.d = 2.5;
  return o.a + o.b + o.c + o.d;
}
console.log("mixed", mixed(fresh('{"a":0,"b":false,"c":"x","d":0}')));
console.log("mixed", mixed(fresh('{"b":false,"d":0,"c":"x","a":0}')));

// Dictionary mode, frozen, and a prototype key: the guard refuses them and
// the site's helper answers.
const dict = fresh('{"qty":1,"price":2}');
Object.defineProperty(dict, "extra", { get() { return 0; }, configurable: true });
console.log("dict", setQty(dict, 9), field(dict, "qty"), field(dict, "extra"));
const frozen = Object.freeze(fresh('{"qty":1,"price":2}'));
try {
  console.log("frozen", setQty(frozen, 9), field(frozen, "qty"));
} catch (e) {
  console.log("frozen threw", e.name, field(frozen, "qty"));
}
const proto = { qty: 40 };
const inherits = Object.create(proto);
inherits.price = 2;
function inheritedQty(o) {
  return o.qty;
}
console.log("proto", setQty(inherits, 9), field(inherits, "qty"), inheritedQty(proto));

// Alternating value kinds over one site, and a store read back by its own
// group in a loop.
function alternate(o, n) {
  let last = 0;
  for (let i = 0; i < n; i++) {
    o.qty = i % 2 === 0 ? i : "s" + i;
    last = o.qty + o.price;
  }
  return last;
}
for (const text of ['{"qty":0,"price":1}', '{"price":1,"qty":0,"z":2}']) {
  const o = fresh(text);
  console.log("alternate", alternate(o, 6), field(o, "qty"), JSON.stringify(o));
}

// A class instance boxed into a dynamic slot: its fields are layout
// properties like any parsed object's.
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
function move(p, dx) {
  p.x = dx;
  return p.x + p.y;
}
const point = new Point(1, 2);
console.log("class", move(point, 10), point.x, point.y);

// A grouped store whose receiver is shared by many readers.
function tick(o) {
  o.n = o.n + 1;
  return o.n;
}
const counter = fresh('{"n":0,"tag":"c"}');
let total = 0;
for (let i = 0; i < 5; i++) total += tick(counter);
console.log("tick", total, counter.n, JSON.stringify(counter));

// A store whose receiver is a member read, not a binding: the store has no
// group of its own, and its own site must replace the slot of an object that
// came from a parse region. The stored value is inert, so the region keeps
// its flag and the document still serializes as it did.
function bumpTag(item, step) {
  item.meta.tag = (item.meta.tag + step) % 7;
  return item.meta.tag + item.meta.weight;
}
const nested = fresh('{"id":1,"meta":{"tag":3,"weight":4}}');
for (let i = 1; i <= 5; i++) console.log("nested", bumpTag(nested, i));
console.log("nestedjson", JSON.stringify(nested), field(nested.meta, "tag"));

// The same for a string and a boolean: every inert kind keeps the region
// intact, and everything else must take the barrier.
function setMeta(item, tag, label, flag) {
  item.meta.tag = tag;
  item.meta.label = label;
  item.meta.flag = flag;
  return item.meta.tag + item.meta.label + item.meta.flag;
}
const mixedMeta = fresh('{"meta":{"tag":0,"label":"a","flag":false}}');
console.log("inertmeta", setMeta(mixedMeta, 2, "z", true), JSON.stringify(mixedMeta));
console.log("inertmeta", setMeta(mixedMeta, 0.5, "y", false), JSON.stringify(mixedMeta));
