// `DisposableStack.prototype` as a value. The prototype object the language
// defines is an ordinary object whose prototype is Object.prototype; it
// carries the stack's six members as non-enumerable data properties,
// `[Symbol.dispose]` is the dispose method itself, and `Symbol.toStringTag`
// is the class's tag. The member values are the same functions a stack's
// members read, so a method called with a receiver that is not a stack
// throws the RequireInternalSlot TypeError, and a method called on a stack
// through the prototype's value works exactly like the stack's own.
const proto = DisposableStack.prototype;

console.log("prototype-of", Object.getPrototypeOf(proto) === Object.prototype);

console.log(
  "typeof",
  typeof proto.use,
  typeof proto.adopt,
  typeof proto.defer,
  typeof proto.move,
  typeof proto.dispose,
);

console.log("lengths", proto.use.length, proto.adopt.length, proto.defer.length);
console.log("names", proto.use.name, proto.adopt.name, proto.move.name);

// The member values are the functions a stack's own members read.
const stack = new DisposableStack();
console.log("same-method", proto.use === stack.use, proto.dispose === stack.dispose);

// Symbol.dispose is the dispose method itself; the tag is the class's.
console.log("symbol-dispose", proto[Symbol.dispose] === proto.dispose);
console.log("tag", String(proto[Symbol.toStringTag]));
console.log("object-tag", Object.prototype.toString.call(proto));

// `disposed` is an accessor: a getter named "get disposed" with length 0,
// no setter, that answers the receiver's flag and refuses a non-stack.
const disposedDescriptor = Object.getOwnPropertyDescriptor(proto, "disposed");
console.log(
  "disposed-accessor",
  typeof disposedDescriptor.get,
  disposedDescriptor.get.name,
  disposedDescriptor.get.length,
  disposedDescriptor.set,
);
const fresh = new DisposableStack();
console.log("disposed-fresh", fresh.disposed);
fresh.dispose();
console.log("disposed-after", fresh.disposed);

// RequireInternalSlot: a receiver that is not a stack throws, whichever
// non-stack value it is — including the prototype object itself.
const use = proto.use;
const throwsFor = (value) => {
  try {
    use.call(value);
    return "no-throw";
  } catch (error) {
    return error.constructor.name;
  }
};
console.log("non-object", throwsFor(undefined), throwsFor(null), throwsFor(1), throwsFor("s"));
console.log("no-slot", throwsFor({}), throwsFor(proto));

// A proper receiver: the call registers the resource like the stack's own.
let disposed = 0;
const resource = {
  [Symbol.dispose]() {
    disposed += 1;
  },
};
const used = use.call(stack, resource);
console.log("call-returns-value", used === resource, stack.disposed);
stack.dispose();
console.log("disposed-once", disposed);
