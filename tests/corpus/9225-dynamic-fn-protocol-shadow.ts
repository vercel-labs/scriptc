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
