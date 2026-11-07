// Each Reflect member below reads as a function value carrying Node's name
// and length, and calls through that value follow Reflect's own rules: a
// non-object target is a TypeError, get and set default their receiver only
// when the argument is absent, and each member answers what Node answers.
// The direct calls of the same members agree with the values.

const target: any = { a: 1, b: "two" };
const isExtensible: any = Reflect.isExtensible;
const preventExtensions: any = Reflect.preventExtensions;
const getOwnPropertyDescriptor: any = Reflect.getOwnPropertyDescriptor;
const has: any = Reflect.has;
const deleteProperty: any = Reflect.deleteProperty;
const get: any = Reflect.get;
const set: any = Reflect.set;
const ownKeys: any = Reflect.ownKeys;

console.log(isExtensible.name, isExtensible.length);
console.log(preventExtensions.name, preventExtensions.length);
console.log(getOwnPropertyDescriptor.name, getOwnPropertyDescriptor.length);
console.log(has.name, has.length, deleteProperty.name, deleteProperty.length);
console.log(get.name, get.length, set.name, set.length, ownKeys.name, ownKeys.length);
console.log(isExtensible(target));
console.log(has(target, "a"), has(target, "missing"), has(target, "toString"));
console.log(get(target, "a"), get(target, "missing"));
console.log(JSON.stringify(getOwnPropertyDescriptor(target, "a")));
console.log(ownKeys(target).join(","), deleteProperty(target, "missing"), deleteProperty(target, "b"));
console.log(ownKeys(target).join(","));
console.log(preventExtensions(target), isExtensible(target), preventExtensions(target));
console.log(set(target, "a", 5), target.a);
console.log(set(target, "c", 3), has(target, "c"));

// The receiver argument defaults to the target only when it is absent.
const receiver: any = { value: 7 };
const accessor: any = {
  get doubled() {
    return this.value * 2;
  },
};
console.log(get(accessor, "doubled", receiver), get(accessor, "doubled"));
const sink: any = { value: 1 };
const other: any = { value: 2 };
console.log(set(sink, "value", 9, other), sink.value, other.value);
console.log(set(sink, "value", 10, undefined), sink.value);
console.log(set(sink, "added", 1, {}), sink.added);

// An unannotated binding of a member keeps the member's own arity: the
// receiver defaults to the target exactly as the direct call does, in a
// module-scope binding and in a function-scope one.
const untypedGet = Reflect.get;
console.log(untypedGet(accessor, "doubled"), untypedGet(accessor, "doubled", receiver));
function readThroughMember(object: any, key: string): unknown {
  const member = Reflect.get;
  return member(object, key);
}
console.log(readThroughMember(accessor, "doubled"), readThroughMember(receiver, "value"));

// Every member throws Reflect's non-object TypeError for a primitive, null
// or undefined target, with the same name and message as Node.
function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, String(run()));
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}
for (const value of [null, undefined, 1, "text", true]) {
  attempt("isExtensible", () => isExtensible(value));
  attempt("preventExtensions", () => preventExtensions(value));
  attempt("getOwnPropertyDescriptor", () => getOwnPropertyDescriptor(value, "a"));
  attempt("has", () => has(value, "a"));
  attempt("deleteProperty", () => deleteProperty(value, "a"));
  attempt("get", () => get(value, "a"));
  attempt("set", () => set(value, "a", 1));
  attempt("ownKeys", () => ownKeys(value));
}

// The direct calls lower to the same runtime operations.
const plain: any = { x: 1 };
console.log(Reflect.isExtensible(plain));
console.log(Reflect.has(plain, "x"), Reflect.get(plain, "x"));
console.log(JSON.stringify(Reflect.getOwnPropertyDescriptor(plain, "x")));
console.log(Reflect.ownKeys(plain).join(","));
console.log(Reflect.preventExtensions(plain), Reflect.isExtensible(plain));
console.log(Reflect.deleteProperty(plain, "x"), Reflect.ownKeys(plain).join(","));
for (const value of [null, undefined, 1, "text", true]) {
  attempt("direct isExtensible", () => Reflect.isExtensible(value as any));
  attempt("direct preventExtensions", () => Reflect.preventExtensions(value as any));
  attempt(
    "direct getOwnPropertyDescriptor",
    () => Reflect.getOwnPropertyDescriptor(value as any, "a") as any,
  );
}

// A class instance held untyped keeps its integrity through the member value.
class Box {
  size = 1;
}
const box = new Box();
console.log(Reflect.isExtensible(box), getOwnPropertyDescriptor(box, "size") !== undefined);
console.log(preventExtensions(box), Reflect.isExtensible(box), isExtensible(box));
