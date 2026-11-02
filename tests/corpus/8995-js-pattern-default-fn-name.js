// ECMAScript NamedEvaluation: an anonymous function definition used as a
// destructuring or parameter DEFAULT takes the name of the binding identifier
// it initializes, so `const [f = function () {}] = []` binds a function whose
// `.name` is "f". Only a definition names: a named function or class
// expression keeps its own name, a default that is any other expression keeps
// the value's own name (a call or a parenthesized comma expression names
// nothing), and only an identifier target names at all.
//
// Every form is covered here: array and object binding patterns, plain and
// destructured parameters, array and object assignment patterns, and a plain
// assignment expression. Each callable kind appears anonymous and named.

const emptyArr = [];
const emptyObj = {};

// Array binding.
const [
  fn = function () {},
  xFn = function x() {},
  arrow = () => {},
  cls = class {},
  xCls = class X {},
  gen = function* () {},
  agen = async function () {},
  aarrow = async () => {},
  cover = (function () {}),
  xCover = (0, function () {}),
  cond = true ? function () {} : function () {},
] = emptyArr;
console.log(
  'array-binding:',
  fn.name,
  xFn.name,
  arrow.name,
  cls.name,
  xCls.name,
  gen.name,
  agen.name,
  aarrow.name,
  JSON.stringify(cover.name),
  JSON.stringify(xCover.name),
  JSON.stringify(cond.name),
);

// Object binding, shorthand and renamed keys: the BINDING names it, not the
// source property name.
const {
  o1 = function () {},
  o2: o3 = class {},
  o4 = function w() {},
  o5 = class Y {},
} = emptyObj;
console.log('object-binding:', o1.name, o3.name, o4.name, o5.name);

// Parameters, including a destructuring parameter and a nested pattern.
function params(a = function () {}, b = function y() {}, c = class {}, d = class Y2 {}, e = () => {}) {
  return [a.name, b.name, c.name, d.name, e.name].join(',');
}
console.log('params:', params());
function paramPattern([p1 = function () {}, p2 = function n() {}, p3 = class {}] = []) {
  return [p1.name, p2.name, p3.name].join(',');
}
console.log('param-pattern:', paramPattern());
function paramObject({ q1 = function () {}, q2 = class {} } = {}) {
  return [q1.name, q2.name].join(',');
}
console.log('param-object:', paramObject());

// Assignment patterns with identifier targets.
let a1, a2, m, z, j;
[a1 = function () {}, a2 = function z2() {}] = emptyArr;
console.log('assign-array:', a1.name, a2.name);
({ m = function () {}, z = class {}, j = class J {} } = emptyObj);
console.log('assign-object:', m.name, z.name, j.name);

// Member targets never name an anonymous definition
// (`[o.p = function () {}]` and `({ q: o.q = class {} } = {})` answer "");
// that shape is refused with SC1031 and belongs to the member-target work.

// A default that is not an anonymous definition keeps the value's own name.
function other() {}
const [ref = other] = emptyArr;
const [namedRef = function explicit() {}] = emptyArr;
console.log('ref-default:', ref.name, namedRef.name);

// A default the source never applies leaves the source's own value, so the
// binding's spelling must not leak into the name: `[fromSrc = function () {}]`
// bound from `[function src() {}]` is "src", and the anonymous element after
// it is "".
const srcFns = [function src() {}, function () {}];
const [fromSrc = function () {}] = srcFns;
const [, anonFromSrc = function () {}] = srcFns;
console.log('source-wins:', fromSrc.name, JSON.stringify(anonFromSrc.name));

// A plain assignment expression names its anonymous definition after the
// target identifier, and an object property initializer after the key.
let plain;
plain = function () {};
const lit = { propFn: function () {}, propArrow: () => {} };
console.log('assign-expr:', plain.name, lit.propFn.name, lit.propArrow.name);

// A parenthesized target is not an identifier reference, so it names nothing
// even though it spells the same identifier.
// Read through the descriptor because a `.name` read of a binding with no
// initializer takes the binding's spelling (a separate, known miss), and use
// `var` because a lexical binding of the same shape names its value that way.
var paren, parenNamed;
(paren) = function () {};
((parenNamed)) = function named3() {};
console.log(
  'assign-paren:',
  JSON.stringify(Object.getOwnPropertyDescriptor(paren, 'name').value),
  Object.getOwnPropertyDescriptor(parenNamed, 'name').value,
);
