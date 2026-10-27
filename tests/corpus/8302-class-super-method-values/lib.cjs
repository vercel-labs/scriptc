"use strict";
// Subclasses whose methods call super, read and called through computed and
// literal keys, as values called with call(), and directly.
class Base {
  constructor(n) { this.n = n; }
  scale(k) { return this.n * k; }
  label() { return "base:" + this.n; }
  plain(k) { return k; }
}
class Child extends Base {
  scale(k) { return super.scale(k) * 10; }
  label() { return "child(" + super.label() + ")"; }
  plain(k) { return k * 100; }
}
class Grandchild extends Child {
  scale(k) { return super.scale(k) + 1; }
}
class Sibling extends Base {
  scale(k) { return -k; }
  plain(k) { return super.plain(k) + 0.5; }
}
exports.make = function (i) {
  switch (i % 4) {
    case 0: return new Base(i);
    case 1: return new Child(i);
    case 2: return new Grandchild(i);
    default: return new Sibling(i);
  }
};
exports.computed = function (value, name, arg) { return value[name](arg); };
exports.viaCall = function (value, name, arg) { const f = value[name]; return f.call(value, arg); };
exports.literal = function (value, arg) { return [value["scale"](arg), value["plain"](arg), value["label"]()].join(" "); };
exports.direct = function (value, arg) { return [value.scale(arg), value.plain(arg), value.label()].join(" "); };
