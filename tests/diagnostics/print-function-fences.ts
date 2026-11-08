// A function value prints by its own name wherever it is held
// (tests/corpus/9398-print-function-values.ts). These neighbours keep a
// refusal: Node's answer is the function's or the class's source text,
// which a compiled program does not carry, or the static fields a class
// value's checked-dynamic form does not hold.
import { format, inspect } from "node:util";

type Filter = (text: string) => string;

function shout(text: string): string {
  return text.toUpperCase();
}

// %s is String(value): the source text.
function formatted(stage: string | Filter): string {
  return format("%s", stage);
}

// So is a template or a concatenation.
function templated(stage: string | Filter): string {
  return `<${stage}>`;
}

class Plain {
  size = 1;
}
class Counted {
  static count = 0;
  size = 1;
}

// A class with static fields prints them after its tag.
function shown(value: typeof Counted): void {
  console.log(value);
}

// %s of a class value.
function classText(value: typeof Plain): string {
  return format("%s", value);
}

console.log(formatted(shout), templated(shout), classText(Plain));
shown(Counted);
console.log(inspect(Plain));
