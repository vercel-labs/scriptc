// JSON.stringify of a union of scalars with a bigint or a symbol arm
// (`bigint | number`, `symbol | string`, `bigint | null`). No arm is a
// record or an array, so the value has no identity to keep and crosses to
// the runtime traversal by value. The traversal answers as Node does: a
// number, string or null serializes; a bigint is a TypeError; a symbol
// makes the result undefined at the top level, drops its key in an object
// and is null in an array.
type Grams = bigint | number;
type Seal = symbol | string;
type Hold = bigint | null;
type Slot = symbol | number | undefined;

function grams(i: number): Grams {
  return i % 2 === 0 ? 250.5 + i : 9007199254740993n;
}
function seal(i: number): Seal {
  return i % 2 === 0 ? 'wax "' + i + '"' : Symbol("lead");
}
function hold(i: number): Hold {
  return i % 2 === 0 ? null : 3n;
}
function slot(i: number): Slot {
  return i === 0 ? 4 : i === 1 ? Symbol("empty") : undefined;
}
function failure(e: unknown): string {
  return e instanceof Error ? e.name + ": " + e.message : "not an error";
}

// The value itself: one call site per union, every arm through it.
for (let i = 0; i < 3; i++) {
  try {
    const weight: Grams = grams(i);
    const text = JSON.stringify(weight);
    console.log("grams", i, typeof text, text);
  } catch (e) {
    console.log("grams", i, failure(e));
  }
  try {
    const mark: Seal = seal(i);
    const text = JSON.stringify(mark);
    console.log("seal", i, typeof text, text);
  } catch (e) {
    console.log("seal", i, failure(e));
  }
  try {
    const kept: Hold = hold(i);
    const text = JSON.stringify(kept, null, 2);
    console.log("hold", i, typeof text, text);
  } catch (e) {
    console.log("hold", i, failure(e));
  }
  try {
    const place: Slot = slot(i);
    const text = JSON.stringify(place);
    console.log("slot", i, typeof text, text);
  } catch (e) {
    console.log("slot", i, failure(e));
  }
}

// The same unions as a record member and as an array element.
interface Parcel {
  to: string;
  weight: Grams;
  seal: Seal;
  hold: Hold;
}
for (let i = 0; i < 4; i++) {
  try {
    const parcel: Parcel = { to: "dock " + i, weight: grams(i < 2 ? 0 : i), seal: seal(i), hold: hold(i < 3 ? 0 : 1) };
    console.log("parcel", i, JSON.stringify(parcel));
  } catch (e) {
    console.log("parcel", i, failure(e));
  }
}
const seals: Seal[] = [seal(0), seal(1), seal(2)];
console.log("seals", JSON.stringify(seals));
const slots: Slot[] = [slot(0), slot(1), slot(2)];
console.log("slots", JSON.stringify(slots));
const weights: Grams[] = [grams(0), grams(2)];
console.log("weights", JSON.stringify(weights));
try {
  weights.push(grams(1));
  console.log("weights", JSON.stringify(weights));
} catch (e) {
  console.log("weights", failure(e));
}

// A replacer sees the bigint or the symbol before the traversal judges it.
for (let i = 0; i < 2; i++) {
  const weight: Grams = grams(i);
  const mark: Seal = seal(i);
  console.log(
    "replaced",
    i,
    JSON.stringify(weight, (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() + "n" : value)),
    JSON.stringify(mark, (_key: string, value: unknown) => (typeof value === "symbol" ? "sealed" : value)),
  );
}
