"use strict";
// isDeepStrictEqual compares two errors' `cause` values before it checks that
// both errors still own a `cause` property. A getter the comparison runs can
// delete the other error's `cause`; the values it read still compare, but the
// errors then differ. The comparison also keeps both causes alive for as long
// as it walks them.
const { isDeepStrictEqual: equal } = require("node:util");

const deleting = (owner, label) => ({
  enumerable: true,
  configurable: true,
  get() {
    console.log("getter", label);
    delete owner.cause;
    return 1;
  },
});

{
  const right = new Error("boom", { cause: { a: 1 } });
  const left = new Error("boom", { cause: {} });
  Object.defineProperty(left.cause, "a", deleting(right, "right"));
  console.log("deleted", equal(left, right), "right cause" in right);
}

// The same shape with the deletion on the left error.
{
  const left = new Error("boom", { cause: { a: 1 } });
  const right = new Error("boom", { cause: {} });
  Object.defineProperty(right.cause, "a", deleting(left, "left"));
  console.log("deleted", equal(left, right), "left cause" in left);
}

// Equal causes compare without any deletion.
console.log("equal", equal(new Error("x", { cause: { a: 1 } }), new Error("x", { cause: { a: 1 } })));
console.log("unequal", equal(new Error("x", { cause: { a: 1 } }), new Error("x", { cause: { a: 2 } })));
console.log("absent", equal(new Error("x"), new Error("x")));
console.log("one", equal(new Error("x", { cause: 1 }), new Error("x")));

// A getter deeper in the left cause deletes the right error's cause before
// the recursive walk reaches it: the walk finishes, then the errors differ.
{
  const right = new Error("deep", { cause: { nested: { a: 1 } } });
  const left = new Error("deep", { cause: { nested: {} } });
  Object.defineProperty(left.cause.nested, "a", deleting(right, "deep right"));
  console.log("deep", equal(left, right), "right cause" in right);
}

// Both errors losing the property leaves their presence equal.
{
  const right = new Error("both", { cause: { a: 1 } });
  const left = new Error("both", { cause: { a: 1 } });
  Object.defineProperty(left.cause, "a", {
    enumerable: true,
    configurable: true,
    get() {
      delete right.cause;
      delete left.cause;
      return 1;
    },
  });
  console.log("both", equal(left, right), "right cause" in right, "left cause" in left);
}

// Nested errors compare their causes the same way.
{
  const right = new Error("outer", { cause: new Error("inner", { cause: { a: 1 } }) });
  const left = new Error("outer", { cause: new Error("inner", { cause: {} }) });
  Object.defineProperty(left.cause.cause, "a", deleting(right.cause, "nested"));
  console.log("nested", equal(left, right), "right cause" in right.cause);
}
