// Destructuring a source the checker proves null or undefined: every form
// throws Node's TypeError before anything is read — an empty pattern
// included, because RequireObjectCoercible and GetIterator both reject the
// unit before any element binds. The source takes the checked-dynamic path
// so the message, the error and the evaluation order match Node's; the
// declared binding still comes into existence for the code after the throw.
function show(label, fn) {
  try {
    fn();
    console.log(label, "no throw");
  } catch (e) {
    console.log(label, e.name + ":", e.message);
  }
}

show("object-literal-null", () => {
  const { a } = null;
  console.log("bound", a);
});
show("object-empty-null", () => {
  const {} = null;
  console.log("bound nothing");
});
show("object-empty-undefined", () => {
  const {} = undefined;
  console.log("bound nothing");
});
show("array-literal-null", () => {
  const [x] = null;
  console.log("bound", x);
});
show("array-empty-null", () => {
  const [] = null;
  console.log("bound nothing");
});
// V8's declaration form spells a bare literal source in the short
// wording; a `void` operand and a parenthesized source do not.
show("array-void0", () => {
  const [x] = void 0;
  console.log("bound", x);
});
show("array-paren-null", () => {
  const [x] = (null);
  console.log("bound", x);
});
show("object-void0", () => {
  const { a } = void 0;
  console.log("bound", a);
});
show("nested-object-null", () => {
  const { p: { q } } = { p: null };
  console.log("bound", q);
});

// Assignment targets take the same path.
show("assign-object-null", () => {
  let a;
  ({ a } = null);
  console.log("bound", a);
});
show("assign-array-null", () => {
  let a;
  [a] = undefined;
  console.log("bound", a);
});

// A `null | undefined` element ({ null }[] reads through the union) has no
// arm left to narrow to, so the nested destructuring can never succeed.
let _;
show("for-of-nested-null", () => {
  let counter = 0;
  for ([[_]] of [[null]]) {
    counter += 1;
  }
  console.log("iterations", counter);
});

// The source evaluates once, before the throw. V8 spells a comma
// expression in the message ("Cannot destructure property 'a' of
// '(evaluations , null)' as it is null."); the lowering keeps the
// checked-dynamic read error there, so this case pins the error type and
// the evaluation count rather than the wording.
let evaluations = 0;
try {
  const { a } = ((evaluations += 1), null);
  console.log("source-evaluated-once no throw");
} catch (e) {
  console.log("source-evaluated-once", e.name);
}
console.log("evaluations", evaluations);

// A for-of head over a unit element throws before the body runs. V8
// spells the implicit source ".for" in the message; the lowering keeps
// the checked-dynamic wording there, so the empty pattern pins the error
// type and the nested one pins the message.
try {
  for (const {} of [null]) {
    console.log("for-of-unit body ran");
  }
  console.log("for-of-unit no throw");
} catch (e) {
  console.log("for-of-unit", e.name);
}
try {
  for (const [{ b }] of [[null]]) {
    console.log("bound", b);
  }
} catch (e) {
  console.log("for-of-nested-unit", e.name + ":", e.message);
}

// Values that are not nil keep binding exactly as before.
const { a: kept, b = 2 } = { a: 1 };
const [first, second = 5] = [0];
console.log("kept", kept, b, first, second);
const empty = {};
const {} = empty;
const nothing = [];
const [] = nothing;
console.log("empty patterns bind nothing");
