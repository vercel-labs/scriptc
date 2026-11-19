// AggregateError reads its errors argument by iteration, so a non-iterable
// reports Node's kind wording ("number 5 is not iterable (cannot read
// property Symbol(Symbol.iterator))"), not the spread-syntax text a user
// spread would throw. Strings, sets, maps and generators iterate.
function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (error) {
    console.log(label, error.name, JSON.stringify(error.message));
  }
}

shape("number", () => new AggregateError(5));
shape("null", () => new AggregateError(null));
shape("undefined", () => new AggregateError(undefined));
shape("object", () => new AggregateError({}));
shape("function", () => new AggregateError(function named() {}));
shape("boolean", () => new AggregateError(true));
shape("symbol", () => new AggregateError(Symbol("s")));
shape("bad iterator", () => new AggregateError({ [Symbol.iterator]: 5 }));
shape("constructor answers primitive", () => new AggregateError({ [Symbol.iterator]() { return 5; } }));
shape("throwing next", () => new AggregateError({
  [Symbol.iterator]() {
    return { next() { throw new RangeError("boom"); } };
  },
}));
shape("throwing iterator getter", () => new AggregateError({
  get [Symbol.iterator]() { throw new TypeError("getter"); },
}));
shape("string", () => new AggregateError("ab").errors.join(","));
shape("set", () => new AggregateError(new Set([1, 2])).errors.join(","));
shape("map", () => new AggregateError(new Map([[1, 2]])).errors.length);
function* generate() {
  yield 1;
  yield 2;
}
shape("generator", () => new AggregateError(generate()).errors.join(","));
