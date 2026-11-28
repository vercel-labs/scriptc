const dependencies: unknown = { "left-pad": "^1.3.0", nested: [1, "two", null] };

process.send?.({
  type: "dependencies",
  dependencies,
  count: 2,
  missing: undefined,
});

const withJson = { a: 1, toJSON: () => ({ b: 2 }) };
process.send?.(withJson);

// A toJSON hook that mutates a later field: Node's stringify runs the hook,
// then walks the record itself, so the sent bytes see the mutation.
const mutating: { a: number; b: number; toJSON: () => { a: number; b: number } } = {
  a: 1,
  b: 0,
  toJSON() {
    this.b = 2;
    return this;
  },
};
process.send?.(mutating);

// A cyclic graph stays a catchable TypeError, as JSON.stringify's is.
const cyclic: { a: number; self?: unknown } = { a: 1 };
cyclic.self = cyclic;
try {
  process.send?.(cyclic);
  process.send?.({ cyclic: "sent" });
} catch (error) {
  // The worker's stdout is ignored, so the answer travels over the channel.
  process.send?.({ cyclic: (error as Error).name });
}

process.disconnect();
