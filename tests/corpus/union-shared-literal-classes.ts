// A union in which two members share one discriminant literal. The members that share it are one kind
// of object (one class, one record), and the literal member decides between classes, so a value whose
// layout fits several arms finds its arm by its literal, from a typed value and from JSON alike.
type Slip =
  | { kind: "shelved"; aisle: number; bay?: string }
  | { kind: "held"; aisle: number; bay?: string; until?: string }
  | { kind: "loan"; via: "desk" }
  | { kind: "loan"; via: "post"; postcode: string; parcels?: number }
  | { kind: "lost"; since: string; fee: number };

function summary(slip: Slip): string {
  if (slip.kind === "shelved") return `aisle ${slip.aisle} bay ${slip.bay ?? "-"}`;
  if (slip.kind === "held") return `held in aisle ${slip.aisle} until ${slip.until ?? "collected"}`;
  if (slip.kind === "lost") return `lost since ${slip.since}, fee ${slip.fee.toFixed(2)}`;
  return slip.via === "post" ? `posted to ${slip.postcode} in ${slip.parcels ?? 1}` : "handed over at the desk";
}

// Typed values whose records two arms hold by width: `shelved` and `held` both have room for them.
interface Shelving {
  kind: "shelved";
  aisle: number;
}
interface Holding {
  kind: "held";
  aisle: number;
}
function shelve(aisle: number): Slip {
  const placed: Shelving = { kind: "shelved", aisle };
  return placed;
}
function hold(held: Holding): Slip {
  return held;
}

// Both members of the class and the lone members, written at the union's type.
const ledger: Slip[] = [
  { kind: "loan", via: "post", postcode: "EH1", parcels: 2 },
  shelve(14),
  { kind: "loan", via: "desk" },
  hold({ kind: "held", aisle: 9 }),
  { kind: "lost", since: "March", fee: 12.5 },
  { kind: "loan", via: "post", postcode: "G12" },
  { kind: "held", aisle: 3, until: "Friday" },
];
for (const slip of ledger) console.log(summary(slip), "|", JSON.stringify(slip), "|", Object.keys(slip).join(","));

// Inside the class: narrowing by the second literal, and by a member's presence.
let posted = 0;
for (const slip of ledger) {
  if (slip.kind !== "loan") continue;
  if (slip.via === "post") posted += slip.postcode.length;
  console.log(slip.via, "postcode" in slip, "postcode" in slip ? slip.postcode : "-", "parcels" in slip);
}
console.log(posted);

// The same values out of JSON land in the arms their literals name.
const stored =
  '[{"kind":"held","aisle":2},{"kind":"loan","via":"desk"},{"kind":"lost","since":"May","fee":3},' +
  '{"kind":"loan","via":"post","postcode":"AB10","parcels":4},{"kind":"shelved","aisle":4,"bay":"c"}]';
const restored = JSON.parse(stored) as Slip[];
console.log(restored.map(summary).join("; "));
console.log(JSON.stringify(restored) === stored);

// And through `unknown`, one value at a time.
const untyped: unknown[] = [...ledger];
console.log(untyped.every((value, at) => summary(value as Slip) === summary(ledger[at]!)), untyped.length);

// The class's members as a type of their own, as a parameter and as a filtered list.
type Loan = Extract<Slip, { kind: "loan" }>;
function route(loan: Loan): string {
  return loan.via === "desk" ? "desk" : `post:${loan.postcode}`;
}
const loans = ledger.filter((slip): slip is Loan => slip.kind === "loan");
console.log(loans.map(route).join(" "), loans.length);
