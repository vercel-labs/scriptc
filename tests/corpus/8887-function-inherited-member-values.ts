// A function inherits `call`, `apply`, `bind` and `toString` from
// Function.prototype, so reading one as a VALUE answers a function, with or
// without an own property of that name ever existing, and again after an
// own property that shadowed it is deleted. The checked-dynamic read used
// to answer only own properties and `apply`: `typeof fn.call` was
// "undefined", and `delete fn.call` left nothing behind to read, while
// member calls kept working through the native lowering.
function make(): any {
  return (n: number) => n + 1;
}

const fn = make();
const members = ["call", "apply", "bind", "toString"];

// Inherited: a function value, not an own property, and `in` finds it.
console.log("typeof", typeof fn.call, typeof fn.apply, typeof fn.bind, typeof fn.toString);
for (const name of members) {
  console.log(
    "inherited",
    name,
    typeof fn[name],
    Object.prototype.hasOwnProperty.call(fn, name),
    name in fn,
  );
}
console.log("keys", Object.keys(fn).join(","));

// One builtin for every function, with Node's name and length.
const other = make();
console.log("shared", fn.call === other.call, fn.bind === other.bind, fn.call === fn.bind);
console.log("call", fn.call.name, fn.call.length, "bind", fn.bind.name, fn.bind.length);
console.log("toString", fn.toString.name, fn.toString.length);

// A held value runs the builtin over the function it is called on.
const call = fn.call;
const bind = fn.bind;
const apply = fn.apply;
console.log("held call", call.call(fn, null, 1));
console.log("held bind", bind.call(fn, null, 2)());
console.log("held apply", apply.call(fn, null, [3]));
console.log("member calls", fn.call(null, 4), fn.apply(null, [5]), fn.bind(null, 6)());

// Called on something that is not a function, the builtin throws.
try {
  call.call({}, null, 1);
  console.log("non-callable", "no throw");
} catch (e) {
  console.log("non-callable", e instanceof TypeError);
}

// An own property shadows the member; deleting it reveals the member again.
fn.call = () => "own call";
console.log("own", typeof fn.call, fn.call(), Object.prototype.hasOwnProperty.call(fn, "call"));
delete fn.call;
console.log(
  "deleted",
  typeof fn.call,
  fn.call(null, 7),
  Object.prototype.hasOwnProperty.call(fn, "call"),
  "call" in fn,
);

// A delete of a member that was never own changes nothing.
delete fn.apply;
delete fn.bind;
delete fn.toString;
console.log("never own", typeof fn.apply, typeof fn.bind, typeof fn.toString);
console.log("still callable", fn.apply(null, [8]), fn.bind(null, 9)());

// Re-adding after the delete, with any value, and deleting it again.
fn.bind = "again";
console.log("re-added", typeof fn.bind, fn.bind, Object.keys(fn).join(","));
delete fn.bind;
console.log("re-deleted", typeof fn.bind, fn.bind(null, 10)(), Object.keys(fn).join(","));
fn.apply = 1;
console.log("apply own", typeof fn.apply);
delete fn.apply;
console.log("apply deleted", typeof fn.apply, fn.apply(null, [11]));

// An own `toString` is the one a member call runs; without one the member
// is the inherited function again.
fn.toString = () => "custom";
console.log("formatter", fn.toString(), typeof fn.toString);
delete fn.toString;
console.log("formatter deleted", typeof fn.toString, Object.prototype.hasOwnProperty.call(fn, "toString"));

// The same reads through a computed key after the writes.
for (const name of members) console.log("computed", name, typeof fn[name]);

// A value that is not a function has no such members.
const record: any = { n: 1 };
console.log("object", typeof record.call, typeof record.bind, typeof record.toString);
export {};
