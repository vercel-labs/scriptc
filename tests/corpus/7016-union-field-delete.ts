// `delete u.f` on a union receiver: every arm declares `f` as an OPTIONAL
// field, so each arm's slot can hold its ABSENT state and the delete
// removes the own property on whichever arm the value has — `in` and
// JSON.stringify agree with Node, and the mutation reaches the caller's
// object rather than a projection of it. A required field (a slot with no
// absence to represent) still refuses at compile time.
interface A {
  type: "a";
  content: string;
  details?: number;
}
interface B {
  type: "b";
  content: string;
  details?: string;
}
type Either = A | B;

function strip(e: Either): Either {
  delete e.details;
  return e;
}

const a: Either = { type: "a", content: "x", details: 1 };
const b: Either = { type: "b", content: "y", details: "d" };
console.log("before", "details" in a, "details" in b, JSON.stringify(a), JSON.stringify(b));

const outA = strip(a);
const outB = strip(b);
console.log("details" in outA, "details" in outB, JSON.stringify(outA), JSON.stringify(outB));
console.log(outA.details, outB.details);

// The delete mutates the value the caller passed (no copy): the alias that
// still holds the arm's own type sees the removal too.
console.log("alias", "details" in a, a.details);

// Deleting an absent field is a no-op, and a later write makes the field
// present again.
const c: A = { type: "a", content: "z" };
delete c.details;
console.log("absent", "details" in c, JSON.stringify(c), c.details);
c.details = 7;
console.log("present", "details" in c, JSON.stringify(c));

// Dispatch through a value produced at run time, both arms of the union.
const pick = (flag: boolean): Either =>
  flag ? strip({ type: "a", content: "p" }) : strip({ type: "b", content: "q", details: "r" });
for (const value of [pick(true), pick(false)]) {
  delete value.details;
  console.log(value.type, "details" in value, JSON.stringify(value), value.content);
}
