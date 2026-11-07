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
