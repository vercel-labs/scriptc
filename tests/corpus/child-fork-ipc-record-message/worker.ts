const dependencies: unknown = { "left-pad": "^1.3.0", nested: [1, "two", null] };

process.send?.({
  type: "dependencies",
  dependencies,
  count: 2,
  missing: undefined,
});

const withJson = { a: 1, toJSON: () => ({ b: 2 }) };
process.send?.(withJson);

process.disconnect();
