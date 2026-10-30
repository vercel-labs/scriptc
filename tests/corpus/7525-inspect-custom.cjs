// [util.inspect.custom] in JavaScript: methods on classes and object
// literals (also keyed by Symbol.for('nodejs.util.inspect.custom')), the
// CommonJS call form (0, util_1.inspect)(value), results that are the
// object itself or another value, a non-function member under the key,
// and the options and util.inspect a method receives.
"use strict";
const util_1 = require("util");

class Temperature {
  constructor(degrees) {
    this.degrees = degrees;
  }
  [util_1.inspect.custom](depth, options, inspect) {
    return `Temperature<${this.degrees}> ${typeof options.stylize} ${inspect === util_1.inspect}`;
  }
}

const literal = {
  id: 1,
  [util_1.inspect.custom](depth) {
    return `literal at depth ${depth}`;
  },
};
const registered = {
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return { replaced: [1, 2], nested: { x: 1 } };
  },
};
const self = {
  v: 1,
  [util_1.inspect.custom]() {
    return this;
  },
};
const notFunction = { x: 1, [util_1.inspect.custom]: "not a function" };
const styled = {
  [util_1.inspect.custom](depth, options) {
    return options.stylize("styled", "special") + options.stylize(5, "number");
  },
};
const nesting = {
  data: { a: { b: { c: 1 } } },
  [util_1.inspect.custom](depth, options, inspect) {
    return `nesting ${inspect(this.data, { ...options, depth: 0 })}`;
  },
};

console.log((0, util_1.inspect)(new Temperature(21)));
console.log((0, util_1.inspect)({ t: new Temperature(22), list: [literal] }));
console.log(util_1.inspect([[literal]], { depth: 0 }));
console.log(util_1.inspect(registered), util_1.inspect({ r: registered }));
console.log(util_1.inspect(self), util_1.inspect(notFunction));
console.log(util_1.inspect(styled), JSON.stringify(util_1.inspect(styled, { colors: true })));
console.log(util_1.inspect(nesting), util_1.inspect({ n: nesting }));
console.log(literal, [registered]);
console.log((0, util_1.format)("%s / %O", literal, literal));
console.log(util_1.inspect(literal, { customInspect: false }));
console.dir(literal);
console.log(util_1.inspect.custom === Symbol.for("nodejs.util.inspect.custom"), util_1.inspect.custom);

const throwing = {
  [util_1.inspect.custom]() {
    throw new RangeError("from custom");
  },
};
try {
  console.log([throwing]);
} catch (error) {
  console.log("caught", error.name, error.message);
}
try {
  util_1.inspect({ t: throwing });
} catch (error) {
  console.log("caught", error.message);
}
