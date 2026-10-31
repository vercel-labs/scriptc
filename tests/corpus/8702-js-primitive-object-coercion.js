// JavaScript runs `in`, `new`, `delete`, and a member read on a primitive,
// and every form that needs an object throws Node's own TypeError. The
// checker's opinions about those operands are opinions about TypeScript
// input, so a JavaScript source keeps the runtime answer and the error text
// byte-for-byte.
function report(fn) {
  try {
    return `ok ${String(fn())}`;
  } catch (error) {
    return `${error.constructor.name} ${error instanceof TypeError} ${error.message}`;
  }
}

// `in` runs ToObject on its right operand, and every primitive fails it with
// the same TypeError spelling both operands.
console.log(report(() => "x" in null));
console.log(report(() => "x" in undefined));
console.log(report(() => "x" in 5));
console.log(report(() => "x" in "abc"));
console.log(report(() => "x" in true));
console.log(report(() => "x" in 5n));
console.log(report(() => "x" in Symbol("z")));

// A checked null still runs: the receiver evaluates exactly once, and the
// throw is Node's, not a lowering fence.
let receiverRuns = 0;
function nullishReceiver() {
  receiverRuns += 1;
  return null;
}
console.log(report(() => "x" in nullishReceiver()));
console.log(receiverRuns);

// A runtime key over a checked-dynamic receiver takes the same check. The
// key's expression evaluates first, then the receiver, and then the throw
// comes before ToPropertyKey: V8 spells an array key by its class, so this
// reports "[object Array]" rather than the "x" the array would have joined
// to.
function dynamicValue(text) {
  return JSON.parse(text);
}
const inOrder = [];
function arrayKey() {
  inOrder.push("key");
  return ["x"];
}
function dynamicReceiver() {
  inOrder.push("receiver");
  return dynamicValue("null");
}
console.log(report(() => arrayKey() in dynamicReceiver()));
console.log(inOrder.join(","));

// `new` runs IsConstructor after the callee and every argument evaluate, and
// names the source spelling of the callee it rejected.
console.log(report(() => new (null)()));
console.log(report(() => new (undefined)()));
console.log(report(() => new (5)()));
const nullCallee = null;
console.log(report(() => new nullCallee()));
const memberCallee = { ctor: null };
console.log(report(() => new memberCallee.ctor()));
const argumentOrder = [];
function recordedArgument() {
  argumentOrder.push("argument");
  return 1;
}
console.log(report(() => new (null)(recordedArgument())));
console.log(argumentOrder.join(","));
const spreadOrder = [];
function spreadArguments() {
  spreadOrder.push("spread");
  return [1];
}
console.log(report(() => new memberCallee.ctor(...spreadArguments())));
console.log(spreadOrder.join(","));

// The checker's type is an opinion about the source, not the value: a
// JavaScript property keeps its initializer's type through a later
// assignment, so a slot that started null can hold a constructor, a
// function, or an object, and it is the value that decides.
const registry = { Ctor: null };
registry.Ctor = function Widget() {
  this.size = 2;
};
console.log("constructed", new registry.Ctor().size);
const methods = { call: null };
methods.call = function () {
  return "called";
};
console.log(methods.call());
const bag = { item: null };
bag.item = { deep: 5 };
console.log(bag.item.deep);
// A class declared in the program reaches the same slot through the same
// check, and a class the slot holds only after the arguments ran is still
// not the callee the construction sees.
class Box {
  constructor(size) {
    this.size = size;
  }
}
const classRegistry = { Ctor: null };
classRegistry.Ctor = Box;
console.log("class slot", new classRegistry.Ctor(3).size, new classRegistry.Ctor(3) instanceof Box);
const mutating = { Ctor: 42 };
console.log(report(() => new mutating.Ctor((mutating.Ctor = Box))));
console.log("slot now", typeof mutating.Ctor, new mutating.Ctor(7).size);

// `delete` runs ToObject on the base after the key: null and undefined throw,
// while every other primitive deletes from a temporary wrapper and answers
// true.
console.log(report(() => delete (null).x));
console.log(report(() => delete (undefined).x));
console.log(report(() => delete (true).x));
console.log(report(() => delete (7).x));
console.log(report(() => delete (5).x));
const deleteOrder = [];
function recordedDeleteKey() {
  deleteOrder.push("key");
  return "x";
}
console.log(report(() => delete (null)[recordedDeleteKey()]));
console.log(deleteOrder.join(","));

// A non-nullish primitive's wrapper reaches ToPropertyKey, so an object
// key's toString runs; the nullish path throws first and never converts.
// `passthrough` keeps the key a checked-dynamic value, as a real program's
// parsed or imported key would be.
function passthrough(value) {
  return value;
}
const conversions = [];
const convertingKey = passthrough({
  toString() {
    conversions.push("toString");
    return "x";
  },
});
console.log(report(() => delete (5)[convertingKey]));
console.log(conversions.join(","));
const unrunKey = passthrough({
  toString() {
    conversions.push("unreachable");
    return "x";
  },
});
console.log(report(() => delete (null)[unrunKey]));
console.log(conversions.join(","));

// The statement form answers the same way.
delete (5).x;
console.log("statement delete ok");
try {
  delete (null).x;
  console.log("unreachable");
} catch (error) {
  console.log(error.constructor.name, error.message);
}
delete (5)[convertingKey];
console.log(conversions.join(","));

// A member read on a nullish receiver throws before anything else runs, and
// the call form reads the member first, so its arguments never evaluate.
const callOrder = [];
function recordedCallArgument() {
  callOrder.push("argument");
  return 1;
}
console.log(report(() => (null).x));
console.log(report(() => (undefined).x));
console.log(report(() => (null).missing(recordedCallArgument())));
console.log(report(() => (undefined)["missing"](recordedCallArgument())));
console.log(callOrder.length);
console.log(report(() => (null)["k"]));
console.log(report(() => (undefined)["k"]));
