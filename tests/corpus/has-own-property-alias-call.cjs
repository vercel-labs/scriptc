// `hasOwnProperty.call(o, k)` through a binding of
// Object.prototype.hasOwnProperty, the way minified packages spell it: own
// keys, inherited and missing keys, arrays, strings and a null receiver.
var hasOwnProperty = Object.prototype.hasOwnProperty;
var o = { a: 1, b: undefined };
var proto = Object.create({ inherited: 1 });
proto.own = 2;
console.log(hasOwnProperty.call(o, "a"), hasOwnProperty.call(o, "b"), hasOwnProperty.call(o, "c"), hasOwnProperty.call(o, "toString"));
console.log(hasOwnProperty.call(proto, "own"), hasOwnProperty.call(proto, "inherited"), hasOwnProperty.call([1], "0"), hasOwnProperty.call("str", "length"));
var copied = {};
for (var k in proto) hasOwnProperty.call(proto, k) && (copied[k] = proto[k]);
console.log(JSON.stringify(copied));
try { hasOwnProperty.call(null, "x"); } catch (e) { console.log(e.constructor.name); }
