// A deep comparison reads `object[key]`, so an accessor property compares
// by what its getter returns, a getter that throws ends the assertion with
// its own error, and a failing comparison shows the accessor's tag without
// calling it again.
import assert from "node:assert";

const answering = () => ({
  get a() {
    return 1;
  },
  b: 2,
});
const throwing = () => ({
  get a() {
    throw new RangeError("from the getter");
  },
});
const attempt = (label, go) => {
  try {
    go();
    console.log(label, "ok");
  } catch (error) {
    console.log(label, "threw", error.name, error.code ?? "no code");
    console.log(error.message);
  }
};

attempt("strict", () => assert.deepStrictEqual(answering(), { a: 1, b: 2 }));
attempt("strict, both accessors", () => assert.deepStrictEqual(answering(), answering()));
attempt("strict, expected accessor", () => assert.deepStrictEqual({ a: 1, b: 2 }, answering()));
attempt("not strict", () => assert.notDeepStrictEqual(answering(), { a: 1, b: 2 }));
attempt("loose", () => assert.deepEqual(answering(), { a: "1", b: 2 }));
attempt("not loose", () => assert.notDeepEqual(answering(), { a: 1, b: 2 }));
attempt("partial", () => assert.partialDeepStrictEqual(answering(), { a: 1 }));
attempt("partial, expected accessor", () =>
  assert.partialDeepStrictEqual({ a: 1, b: 2, c: 3 }, answering()),
);
attempt("nested", () => assert.partialDeepStrictEqual({ o: answering() }, { o: { a: 1 } }));
attempt("in an array", () => assert.deepStrictEqual([answering()], [{ a: 1, b: 2 }]));

attempt("strict mismatch", () => assert.deepStrictEqual(answering(), { a: 2, b: 2 }));
attempt("partial mismatch", () => assert.partialDeepStrictEqual(answering(), { a: 2 }));
attempt("setter only", () =>
  assert.deepStrictEqual(
    {
      set a(value) {},
      b: 2,
    },
    { a: 2, b: 2 },
  ),
);
attempt("setter only reads undefined", () =>
  assert.deepStrictEqual(
    {
      set a(value) {},
    },
    { a: undefined },
  ),
);

attempt("strict, getter throws", () => assert.deepStrictEqual(throwing(), { a: 1 }));
attempt("strict, expected getter throws", () => assert.deepStrictEqual({ a: 1 }, throwing()));
attempt("loose, getter throws", () => assert.deepEqual(throwing(), { a: 1 }));
attempt("partial, getter throws", () => assert.partialDeepStrictEqual(throwing(), { a: 1 }));
attempt("partial, expected getter throws", () =>
  assert.partialDeepStrictEqual({ a: 1 }, throwing()),
);
attempt("not strict, getter throws", () => assert.notDeepStrictEqual(throwing(), { a: 1 }));

// A non-enumerable own property takes no part in a comparison, whether it
// holds a value or an accessor.
const withHidden = (descriptor) => {
  const object = {};
  object.b = 2;
  Object.defineProperty(object, "a", descriptor);
  return object;
};
attempt("non-enumerable accessor", () =>
  assert.deepStrictEqual(
    withHidden({
      get() {
        return 1;
      },
    }),
    { b: 2 },
  ),
);
attempt("non-enumerable value", () => assert.deepStrictEqual(withHidden({ value: 1 }), { b: 2 }));
attempt("non-enumerable against enumerable", () =>
  assert.deepStrictEqual(withHidden({ value: 1 }), { a: 1, b: 2 }),
);
attempt("enumerable accessor defined later", () =>
  assert.deepStrictEqual(
    withHidden({
      get() {
        return 1;
      },
      enumerable: true,
    }),
    { b: 2, a: 1 },
  ),
);
attempt("object result", () =>
  assert.deepStrictEqual(
    {
      get a() {
        return { x: 1 };
      },
    },
    { a: { x: 2 } },
  ),
);
attempt("null result", () =>
  assert.deepStrictEqual(
    {
      get a() {
        return null;
      },
    },
    { a: 2 },
  ),
);
let reads = 0;
attempt("getter throws when the message reads it", () =>
  assert.deepStrictEqual(
    {
      get a() {
        if (reads++ > 0) throw new Error("later");
        return 1;
      },
    },
    { a: 2 },
  ),
);

let calls = 0;
const counting = {
  get a() {
    calls++;
    return 1;
  },
};
attempt("counted", () => assert.deepStrictEqual(counting, { a: 1 }));
console.log("getter calls", calls);
