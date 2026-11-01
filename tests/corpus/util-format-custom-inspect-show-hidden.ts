// util.format's %o walk renders with hidden properties, so a custom
// inspector sees showHidden: true inside that substitution while %O,
// console.log and util.inspect see false. Nested inspect and format calls
// inside the callback start from their own defaults, and the surrounding
// walk's flag is back when they return or throw.
import * as util from "node:util";

function mark(name: string, options: any): string {
  return name + (options.showHidden ? " showHidden" : " default");
}

class Custom {
  [util.inspect.custom](depth: unknown, options: any): string {
    return mark("Custom", options);
  }
}
const literal: unknown = {
  [util.inspect.custom](depth: unknown, options: any): string {
    return mark("literal", options);
  },
};
const value: unknown = new Custom();

console.log(util.format("%O", value));
console.log(util.format("%o", value));
console.log(util.format("%o", { nested: value }));
console.log(util.format("%O", { nested: value }));
console.log(util.format("%O", value));

// Each placeholder in a mixed call keeps its own walk.
console.log(util.format("%o|%O|%o|%O", value, value, { nested: value }, value));

// An object literal's inspector sees the same flag as a class instance's.
console.log(util.format("%o", literal), util.format("%O", literal));
console.log(util.format("%o", { a: [literal, 1] }));
console.log(util.format("%O", { a: [literal, 1] }));

// console.log and util.inspect render with %O's walk.
console.log(value);
console.log(util.inspect(value));

// Nested calls use their own defaults, and the outer walk's flag is back
// when they return.
class Nested {
  [util.inspect.custom](depth: unknown, options: any): string {
    return [
      mark("Nested", options),
      util.inspect(value),
      util.format("%O", value),
      util.format("%o", value),
      util.inspect({ inner: value }),
    ].join(" ");
  }
}
const nested: unknown = new Nested();
console.log(util.format("%o", nested));
console.log(util.format("%O", nested));
console.log(util.format("%o", { list: [nested, value] }));

// A callback that throws mid-walk leaves the next call on its defaults.
class Throws {
  [util.inspect.custom](): string {
    throw new Error("boom");
  }
}
const throwing: unknown = new Throws();
try {
  console.log(util.format("%o", throwing));
} catch (e) {
  console.log("caught", (e as Error).message);
}
console.log(util.format("%O", value));
console.log(util.format("%o", value));
