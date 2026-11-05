// Async iteration over values whose [Symbol.asyncIterator] shape only exists
// at run time. JavaScript puts no static demand on the receiver: the protocol
// reads the method, calls it, and throws TypeError when the method is missing,
// is not callable, or returns a non-object. The checker must not refuse the
// source for the shapes inference cannot prove.
function report(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => console.log(label, "ok", value),
      (error) => console.log(label, error instanceof TypeError, error.name),
    );
}

async function* delegate(value) {
  yield* value;
}

async function drain(value) {
  const values = [];
  for await (const item of value) values.push(item);
  return values.join(",");
}

async function main() {
  // A well-formed async iterator written inline still delegates.
  await report("inline", () =>
    drain({
      async *[Symbol.asyncIterator]() {
        yield "a";
        yield "b";
      },
    }),
  );

  // The method is a data property, not a function.
  await report("method-not-callable", () => drain({ [Symbol.asyncIterator]: 42 }));

  // The method returns a number instead of an iterator object.
  await report("result-not-object", () => drain({ [Symbol.asyncIterator]() { return 42; } }));

  // The returned iterator's next is not callable.
  await report("next-not-callable", () =>
    drain({
      [Symbol.asyncIterator]() {
        return { next: "nope" };
      },
    }),
  );

  // No async iterator at all and no sync fallback either.
  await report("no-protocol", () => drain({ value: 1 }));

  // yield* delegates through the same protocol, so it throws the same way.
  await report("yield-star-not-callable", async () => {
    let seen = "";
    for await (const value of delegate({ [Symbol.asyncIterator]: true })) seen += value;
    return seen;
  });

  await report("yield-star-result-not-object", async () => {
    let seen = "";
    for await (const value of delegate({ [Symbol.asyncIterator]() { return "text"; } })) seen += value;
    return seen;
  });

  // A non-callable async iterator wins over a working sync iterator: the
  // protocol only falls back when the method is undefined.
  await report("async-shadows-sync", () =>
    drain({
      [Symbol.asyncIterator]: 0,
      *[Symbol.iterator]() {
        yield "never";
      },
    }),
  );

  // A value with only a sync iterable iterates through the sync fallback.
  await report("sync-only", () =>
    drain({
      *[Symbol.iterator]() {
        yield "s1";
        yield "s2";
      },
    }),
  );

  // yield* over arrays and strings keeps working.
  await report("yield-star-array", async () => {
    let seen = "";
    for await (const value of delegate([1, 2])) seen += value;
    return seen;
  });
}

main();
