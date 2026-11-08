// The checked-dynamic view of a function reads an own property before the
// builtin that the native call/apply/bind lowering would otherwise run.
function make(): any {
  return () => "body";
}

const fn = make();
fn.apply = () => "own apply";
fn.call = () => "own call";
fn.bind = () => "own bind";
console.log(fn.apply(), fn.call(), fn.bind(), fn());
console.log(Object.keys(fn).join(","), typeof fn);

// A value with no own property keeps the builtin: call runs the function.
const plain = make();
console.log(plain.call(null), Object.keys(plain).join(","));

// defineProperty writes the same own property.
const other = make();
Object.defineProperty(other, "apply", {
  value: () => "defined",
  enumerable: true,
  configurable: true,
});
console.log(other.apply(), Object.keys(other).join(","));

// Deleting it reveals the builtin again.
delete other.apply;
console.log(other.apply(null), Object.keys(other).join(","));

// The callee is read before the arguments run: an argument that replaces
// or deletes the own property does not change the function the call runs.
const ordered = make();
ordered.call = () => "first call";
console.log(ordered.call((ordered.call = () => "second call", null)), ordered.call());
ordered.apply = () => "first apply";
console.log(ordered.apply((delete ordered.apply, null)), ordered.apply(null));
ordered.bind = () => "first bind";
console.log(ordered.bind((ordered.bind = () => "second bind", null)), ordered.bind());

// An argument that stores the property where there was none comes too late
// for this call as well: the builtin was the callee.
const late = make();
console.log(late.call((late.call = () => "stored by the argument", null)), late.call(null));
const swapped = make();
const swap = (): null => {
  swapped.apply = () => "stored by a call";
  return null;
};
console.log(swapped.apply(swap()), swapped.apply(null));

// A property that is not a function is still the callee that was read.
const broken = make();
broken.call = 5;
try {
  broken.call((broken.call = () => "repaired", null));
} catch (e) {
  console.log(e instanceof TypeError, typeof broken.call);
}
