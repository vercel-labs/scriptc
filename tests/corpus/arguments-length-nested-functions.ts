// A typed rest function declared inside another function reads the hidden actual-argument list too: its lifted signature carries the same trailing array, and a call through its binding completes the same way a top-level call does. The count follows every call — the parameters a call names, a spread, and a value the nested code stores in another binding — at any nesting depth and inside a class method.
function declaration(): string {
  function inner(...values: string[]): string {
    return `${arguments.length}:${values.join("-")}`;
  }
  return `${inner("a", "b")}|${inner()}|${inner("z")}`;
}

function withHead(): string {
  function inner(head: string, ...values: string[]): string {
    return `${arguments.length}:${head}:${values.join("-")}`;
  }
  return `${inner("h", "a", "b")}|${inner("h")}`;
}

function expression(): string {
  const inner = function (head: string, ...values: string[]): string {
    return `${arguments.length}:${head}:${values.join("-")}`;
  };
  return `${inner("h", "a", "b")}|${inner("h")}`;
}

function deep(): string {
  function middle(): string {
    function inner(...values: string[]): string {
      return `${arguments.length}:${values.join("-")}`;
    }
    return inner("x", "y", "z");
  }
  return middle();
}

function heldValue(): string {
  function inner(...values: string[]): string {
    return `${arguments.length}:${values.join("-")}`;
  }
  const two = inner;
  const many = ["d", "e"];
  return `${inner("a", "b")}|${two("c")}|${inner(...many)}`;
}

function arrow(): string {
  const inner = (...values: string[]): string => values.length.toString();
  return inner("a", "b");
}

class Local {
  run(): string {
    function inner(head: string, ...values: number[]): string {
      return `${arguments.length}:${head}:${values.join("+")}`;
    }
    return inner("h", 1, 2);
  }
}

console.log(declaration());
console.log(withHead());
console.log(expression());
console.log(deep());
console.log(heldValue());
console.log(arrow());
console.log(new Local().run());
