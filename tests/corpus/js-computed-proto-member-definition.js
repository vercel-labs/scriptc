// A member of a JavaScript object literal is a property definition, not an
// assignment, so a computed key that evaluates to `__proto__` creates an own
// data property and leaves the literal's [[Prototype]] alone.
const key = JSON.parse('"__proto__"');
const number = { [key]: 5, after: 1 };
console.log("number", number.__proto__ === 5, Object.getPrototypeOf(number) === Object.prototype);
console.log("number names", Object.getOwnPropertyNames(number).join(","));

const object = { marker: 1 };
const value = { [key]: object, after: 2 };
console.log("object", value.__proto__ === object, Object.getPrototypeOf(value) === Object.prototype);
console.log("object names", Object.getOwnPropertyNames(value).join(","));

// A string-typed key computed at run time takes the same route.
const spelled = key === "other" ? "other" : "__proto__";
const byString = { [spelled]: 6 };
console.log(
  "string",
  byString.__proto__ === 6,
  Object.getPrototypeOf(byString) === Object.prototype,
  Object.getOwnPropertyNames(byString).join(","),
);

// A non-key value: ToPropertyKey of a number.
const numeric = { [1]: "one" };
console.log("numeric", numeric[1], Object.getOwnPropertyNames(numeric).join(","));

// A computed string literal keeps its existing route.
const literal = { ["__proto__"]: 7 };
console.log("literal", literal.__proto__ === 7, Object.getPrototypeOf(literal) === Object.prototype);

// The accessor still answers an assignment: only a definition bypasses it.
const assigned = {};
assigned[key] = object;
console.log(
  "assigned",
  Object.getPrototypeOf(assigned) === object,
  Object.prototype.hasOwnProperty.call(assigned, "__proto__"),
);
