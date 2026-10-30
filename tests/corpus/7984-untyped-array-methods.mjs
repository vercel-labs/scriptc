// Untyped calls of push, pop, shift, at, includes and indexOf: plain arrays
// take a direct path; arrays with holes, frozen, sealed or non-extensible
// arrays, Array.prototype, proxies, and arrays whose own property or
// prototype defines the method take the full dispatch. Each call is made
// both for its result and as a statement, whose result is dropped.
function attempt(label, f) {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "threw", e.constructor.name, e.message);
  }
}
function push(a, v) {
  return a.push(v);
}
function pushOnly(a, v) {
  a.push(v);
  return a.length;
}
function push2(a, v, w) {
  return a.push(v, w);
}
function pop(a) {
  return a.pop();
}
function shift(a) {
  return a.shift();
}
function at(a, i) {
  return a.at(i);
}
function includes(a, v) {
  return a.includes(v);
}
function indexOf(a, v) {
  return a.indexOf(v);
}
function indexFrom(a, v, from) {
  return a.indexOf(v, from);
}
function len(a) {
  return a.length;
}

const holes = JSON.parse("[1, 2, 3]");
delete holes[1];
attempt("holes push", () => push(holes, 4));
attempt("holes push statement", () => pushOnly(holes, 5));
attempt("holes includes", () => [includes(holes, undefined), indexOf(holes, undefined), at(holes, 1)]);
attempt("holes pop", () => [pop(holes), len(holes)]);
attempt("holes shift", () => [shift(holes), len(holes), 1 in holes]);

const frozen = Object.freeze(JSON.parse("[1, 2]"));
attempt("frozen push", () => push(frozen, 3));
attempt("frozen push statement", () => pushOnly(frozen, 3));
attempt("frozen pop", () => pop(frozen));
attempt("frozen shift", () => shift(frozen));
attempt("frozen includes", () => [includes(frozen, 2), indexOf(frozen, 2), at(frozen, -1)]);

const sealed = Object.seal(JSON.parse("[1, 2]"));
attempt("sealed push", () => push(sealed, 3));
attempt("sealed push statement", () => pushOnly(sealed, 3));
attempt("sealed pop", () => pop(sealed));
attempt("sealed shift", () => [shift(sealed), JSON.stringify(sealed)]);
attempt("sealed includes", () => [includes(sealed, 2), at(sealed, 0)]);

const fixed = Object.preventExtensions(JSON.parse("[1, 2]"));
attempt("fixed push", () => push(fixed, 3));
attempt("fixed push statement", () => pushOnly(fixed, 3));
attempt("fixed pop", () => [pop(fixed), len(fixed)]);
attempt("fixed shift", () => [shift(fixed), len(fixed)]);

attempt("prototype includes", () => [includes(Array.prototype, 1), indexOf(Array.prototype, 1), at(Array.prototype, 0)]);

const handler = new Proxy({ push(v) { return "proxied push " + v; }, at(i) { return "proxied at " + i; } }, {});
attempt("proxy push", () => push(handler, 7));
attempt("proxy push statement", () => pushOnly(handler, 7));
attempt("proxy at", () => at(handler, 1));

const own = JSON.parse("[1, 2]");
own.push = function (v) {
  return "own push " + v;
};
own.includes = function (v) {
  return "own includes " + v;
};
attempt("own push", () => [push(own, 9), len(own)]);
attempt("own push statement", () => pushOnly(own, 9));
attempt("own includes", () => [includes(own, 1), indexOf(own, 1)]);
const notCallable = JSON.parse("[1, 2]");
notCallable.pop = 5;
attempt("own non-callable pop", () => pop(notCallable));

const customProto = Object.create(Array.prototype);
customProto.push = function (v) {
  return "proto push " + v + " onto " + this.length;
};
const reproto = JSON.parse("[1, 2]");
Object.setPrototypeOf(reproto, customProto);
attempt("reproto push", () => push(reproto, 9));
attempt("reproto push statement", () => pushOnly(reproto, 9));
attempt("reproto pop", () => [pop(reproto), len(reproto)]);

const plain = JSON.parse("[]");
for (let i = 0; i < 5; i++) push2(plain, i, i * 2);
for (let i = 0; i < 3; i++) pushOnly(plain, "s" + i);
attempt("plain", () => [len(plain), pop(plain), shift(plain), at(plain, -2), at(plain, 1.9), at(plain, -0), at(plain, NaN), at(plain, 100), at(plain, -100)]);
attempt("plain search", () => [includes(plain, 8), indexOf(plain, 8), includes(plain, "s1"), indexOf(plain, "s1"), indexOf(plain, "s9"), indexFrom(plain, 2, 3), includes(plain)]);
attempt("plain at string", () => [at(plain, "1"), at(plain, undefined), at(plain, { valueOf() { return 2; } })]);
const nans = JSON.parse("[1]");
pushOnly(nans, NaN);
pushOnly(nans, -0);
attempt("nan", () => [includes(nans, NaN), indexOf(nans, NaN), includes(nans, 0), indexOf(nans, 0), indexOf(nans, -0)]);
const empty = JSON.parse("[]");
attempt("empty", () => [pop(empty), shift(empty), at(empty, 0), includes(empty, undefined), indexOf(empty, undefined), len(empty)]);
const objects = JSON.parse("[]");
const key = { k: 1 };
pushOnly(objects, key);
pushOnly(objects, { k: 1 });
attempt("objects", () => [includes(objects, key), indexOf(objects, key), indexOf(objects, { k: 1 }), at(objects, 0) === key]);
