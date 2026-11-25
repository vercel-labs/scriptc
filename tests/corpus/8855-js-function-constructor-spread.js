// @disallow-code-generation
// `new Function(...parts)` throws the EvalError every code-generation call
// throws in a compiled program, after the spread's elements have converted
// to strings in order. A capability probe around it takes its interpreted
// path.

function evaluate(...parts) {
  return new (globalThis.Function)(...parts);
}

function canEvaluate() {
  try {
    evaluate("return 1")();
    return true;
  } catch {
    return false;
  }
}

console.log("can evaluate", canEvaluate());

// The elements of the spread are the constructor's arguments.
function build(...parts) {
  try {
    new Function(...parts);
    return "built";
  } catch (e) {
    return `${e instanceof EvalError} ${e.message}`;
  }
}
console.log(build("a", "b", "return a + b"));
console.log(build("x", 1));
console.log(build());

try {
  Function(...["a", "b"], "return a + b");
  console.log("built");
} catch (e) {
  console.log(e instanceof EvalError, e.message);
}

// Each element converts to a string, in order, before the refusal.
const order = [];
const first = {
  toString() {
    order.push("first");
    return "a";
  },
};
const second = {
  toString() {
    order.push("second");
    return "return a";
  },
};
console.log(build(first, second), order.join(","));

// A spread of something that is not iterable fails as any spread call does.
function spreadOf(value) {
  try {
    new Function(...value);
    return "built";
  } catch (e) {
    return `${e.constructor.name}: ${e.message}`;
  }
}
console.log(spreadOf(5));
console.log(spreadOf(undefined));
console.log(spreadOf("ab"));

// A class instance among the elements converts through its own toString,
// and an exception it throws leaves before the refusal.
class Named {
  toString() {
    order.push("named");
    return "x";
  }
}
class Loud {
  toString() {
    order.push("loud");
    throw new RangeError("loud");
  }
}
order.length = 0;
console.log(build(new Named(), "return x"), order.join(","));
console.log(build("a", new Loud(), new Named()), order.join(","));
const parts = [new Named(), new Loud()];
try {
  new Function(...parts);
} catch (e) {
  console.log(e.constructor.name, e.message, order.join(","));
}
try {
  Function(...[new Named()], new Loud());
} catch (e) {
  console.log(e.constructor.name, e.message, order.join(","));
}
