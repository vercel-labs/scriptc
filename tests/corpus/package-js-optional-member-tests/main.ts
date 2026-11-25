// A package compiled from its JavaScript is called with a record that has
// optional members. Its code tests a member for undefined before it calls a
// method on it; the checker types the member `any` there and cannot use the
// test, so the call is compiled for the value the member holds: a missing
// member throws JavaScript's own TypeError, a present one is the receiver.
import {
  addMark,
  byEarlyReturn,
  byElse,
  byLocal,
  byLooseNull,
  byTernary,
  byTruthiness,
  byTypeof,
  inClosure,
  inLoop,
  ratio,
  ratioByChain,
  seen,
  shout,
  unguarded,
  type Row,
} from "tally-kit";

const full: Row = { id: "full", marks: ["x", "y"], ratio: 2.25, seen: new Set(["a"]) };
const bare: Row = { id: "bare" };

for (const row of [full, bare]) {
  console.log(
    row.id,
    byTernary(row),
    byEarlyReturn(row),
    byLocal(row),
    byLooseNull(row),
    byTruthiness(row),
    byTypeof(row),
    byElse(row),
  );
  console.log(row.id, inClosure(row), ratio(row), ratioByChain(row), seen(row));
}
console.log(inLoop([full, bare, full]));

// The method ran on the member itself, not on a copy.
console.log(addMark(full, "z"), full.marks?.join(","), addMark(bare, "z"), bare.marks === undefined);

// Without a test the call on a missing member is JavaScript's TypeError.
console.log(unguarded(full));
try {
  console.log(unguarded(bare));
} catch (error) {
  console.log(error instanceof TypeError, error instanceof Error ? error.message : "?");
}

const text: string | undefined = process.argv.length > 9 ? undefined : "quiet";
const missing: string | undefined = process.argv.length > 9 ? "x" : undefined;
console.log(shout(text), shout(missing));
