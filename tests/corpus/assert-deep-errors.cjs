// assert.deepStrictEqual over two Error values: Node compares errors by
// name, message, cause and an AggregateError's errors whatever their
// enumerability, and never by stack. A statically typed Error pair used to
// fence; it now compares through the runtime's error arm, and a failing
// comparison renders the non-enumerable [cause] the way Node's diff does.
// The loose pair and the negation share the rules.
"use strict";
const assert = require("node:assert");

const show = (label, f) => {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, "differ");
    console.log(e.message);
  }
};

// Equal values, different creation sites (the stacks differ).
const siteA = () => new Error("x");
show("strict-equal", () => assert.deepStrictEqual(siteA(), siteA()));
show("strict-causes-equal", () =>
  assert.deepStrictEqual(new Error("x", { cause: 1 }), new Error("x", { cause: 1 })),
);
show("strict-extra-equal", () =>
  assert.deepStrictEqual(
    Object.assign(new Error("x"), { code: "A" }),
    Object.assign(new Error("x"), { code: "A" }),
  ),
);
show("strict-aggregate-equal", () =>
  assert.deepStrictEqual(
    new AggregateError([new Error("a")], "m"),
    new AggregateError([new Error("a")], "m"),
  ),
);
show("loose-equal", () => assert.deepEqual(siteA(), siteA()));
show("not-deep-strict", () => assert.notDeepStrictEqual(new Error("x"), new Error("y")));

show("strict-cause-diff", () =>
  assert.deepStrictEqual(new Error("x", { cause: 1 }), new Error("x", { cause: 2 })),
);
show("strict-extra-diff", () =>
  assert.deepStrictEqual(
    Object.assign(new Error("x"), { code: "A" }),
    Object.assign(new Error("x"), { code: "B" }),
  ),
);
show("strict-name-diff", () => assert.deepStrictEqual(new Error("x"), new TypeError("x")));
show("strict-message-diff", () => assert.deepStrictEqual(new Error("x"), new Error("y")));
show("strict-aggregate-diff", () =>
  assert.deepStrictEqual(
    new AggregateError([new Error("a")], "m"),
    new AggregateError([new Error("b")], "m"),
  ),
);
show("strict-nested-cause-diff", () =>
  assert.deepStrictEqual(
    new Error("x", { cause: new Error("k", { cause: 1 }) }),
    new Error("x", { cause: new Error("k", { cause: 2 }) }),
  ),
);
show("loose-cause-diff", () =>
  assert.deepEqual(new Error("x", { cause: 1 }), new Error("x", { cause: 2 })),
);
show("partial-cause-diff", () =>
  assert.partialDeepStrictEqual(new Error("x", { cause: 1 }), new Error("x", { cause: 2 })),
);
show("not-deep-strict-same", () => assert.notDeepStrictEqual(siteA(), siteA()));

// Accessor-backed error properties are read (the getter's value is
// compared, a getter's throw propagates), never their stored placeholder.
const withCause = (v) => {
  const e = new Error("x");
  Reflect.defineProperty(e, "cause", { get() { return v; }, configurable: true });
  return e;
};
const throwingCause = () => {
  const e = new Error("x");
  Reflect.defineProperty(e, "cause", { get() { throw new RangeError("boom"); }, configurable: true });
  return e;
};
show("getter-equal", () => assert.deepStrictEqual(withCause(1), withCause(1)));
show("getter-diff", () => assert.deepStrictEqual(withCause(1), withCause(2)));
show("getter-throws", () => assert.deepStrictEqual(throwingCause(), throwingCause()));
show("loose-getter-diff", () => assert.deepEqual(withCause(1), withCause(2)));
show("loose-getter-throws", () => assert.deepEqual(throwingCause(), throwingCause()));

// The class a strict comparison sees: a subclass instance never equals the
// base class's error, and two classes never equal each other, whatever
// their name and message. Only the verdict is pinned: the failure text of
// two subclass errors names both sides "Error" in the diff (the
// materialized view carries the class only through its typed reference).
class MyError extends Error {}
class OtherError extends Error {}
const hold = (v) => v;
const verdict = (label, f) => {
  try {
    f();
    console.log(label, "ok");
  } catch (e) {
    console.log(label, e.name);
  }
};
verdict("subclass-same", () => assert.deepStrictEqual(new MyError("x"), new MyError("x")));
verdict("subclass-vs-base", () => assert.deepStrictEqual(new MyError("x"), new Error("x")));
verdict("subclass-other", () => assert.deepStrictEqual(new MyError("x"), new OtherError("x")));
verdict("dyn-subclass-other", () =>
  assert.deepStrictEqual(hold(new MyError("x")), hold(new OtherError("x"))),
);
verdict("loose-subclass-vs-base", () => assert.deepEqual(new MyError("x"), new Error("x")));
