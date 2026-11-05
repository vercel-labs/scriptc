// An empty destructuring pattern still performs its one observable step:
// RequireObjectCoercible for `{}` and GetIterator for `[]`. A checked-dynamic
// source reaches that step at runtime, so null and undefined throw the same
// TypeError Node does while every other value — including primitives, which
// ToObject wraps — is accepted. The throws are printed through
// `instanceof` rather than the message, since V8 spells the source
// differently per position (an argument is "object null", a declaration
// names its expression).

function report(label, fn) {
  try {
    fn();
    console.log(label, "no-throw");
  } catch (error) {
    console.log(label, error instanceof TypeError ? "TypeError" : "other");
  }
}

function acceptsWhatever(value) {
  return value;
}

report("object-null", () => {
  const source = acceptsWhatever(null);
  const {} = source;
});
report("object-undefined", () => {
  const source = acceptsWhatever(undefined);
  const {} = source;
});

function objectParameter({}) {
  return "bound";
}
report("param-null", () => {
  objectParameter(null);
});
report("param-undefined", () => {
  objectParameter(undefined);
});
report("param-number", () => {
  console.log("param-number returned", objectParameter(7));
});
report("param-string", () => {
  console.log("param-string returned", objectParameter("text"));
});

function arrayParameter([]) {
  return "bound";
}
report("array-param-null", () => {
  arrayParameter(null);
});
report("array-param-undefined", () => {
  arrayParameter(undefined);
});

function nestedObject({ inner: {} }) {
  return "nested";
}
report("nested-null", () => {
  nestedObject({ inner: null });
});
report("nested-undefined", () => {
  nestedObject({ inner: undefined });
});
report("nested-object", () => {
  console.log("nested-object returned", nestedObject({ inner: {} }));
});

// A loop head rebinds the pattern per iteration, exactly like a declaration.
report("for-of-object", () => {
  for (const {} of acceptsWhatever([null])) {
    console.log("never");
  }
});

// Non-nullish primitives are accepted by both pattern kinds.
report("primitives", () => {
  const numbers = [0, "", false, 1, "x"];
  for (const value of numbers) {
    const {} = value;
    console.log("destructured", JSON.stringify(value), typeof value);
  }
});

// The assignment form keeps its own (already exact) check.
report("assignment-null", () => {
  let bound;
  ({} = bound);
});
report("assignment-number", () => {
  let bound = 5;
  ({} = bound);
  console.log("assignment-number finished");
});
