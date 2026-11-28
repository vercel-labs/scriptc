// A missing asserted read of a dictionary whose value type has a null arm
// keeps its runtime value. Non-numeric uses see the undefined itself:
// String() and templates print it, JSON.stringify answers undefined for the
// root and drops an object member, and a present null cell serializes as
// null. Numeric uses keep ToNumber's answers: undefined is NaN and null is 0.
// A checker lie (a null cell behind a number type) prints and serializes as
// null. Node 24 is the oracle.
const data: Record<string, unknown> = { cell: null, n: 41 };
const nullable = data as Record<string, number | null>;
const lying = data as Record<string, number>;

console.log("lying string", String(lying["cell"]!), `tpl=${lying["cell"]!}`);
console.log("lying null test", lying["cell"]! === null);
console.log("lying json", JSON.stringify(lying["cell"]!));
console.log("lying numeric", lying["cell"]! + 1, Math.abs(lying["cell"]!));

console.log("missing string", String(nullable["missing"]!), `tpl=${nullable["missing"]!}`);
console.log("missing json root", String(JSON.stringify(nullable["missing"]!)));
console.log("missing json member", JSON.stringify({ k: nullable["missing"]! }));
console.log("null json root", JSON.stringify(nullable["cell"]!));
console.log("null json member", JSON.stringify({ k: nullable["cell"]! }));
console.log("present json member", JSON.stringify({ k: nullable["n"]! }));
console.log("missing numeric", nullable["missing"]! + 1, Math.abs(nullable["missing"]!));
console.log("null numeric", nullable["cell"]! + 1, Math.abs(nullable["cell"]!));

const mapped = [1, 2].map(() => JSON.stringify({ k: nullable["missing"]! }));
console.log("callback", mapped.join(","));
function memberText(): string {
  return JSON.stringify({ k: nullable["missing"]! });
}
function rootText(): string {
  return JSON.stringify(nullable["missing"]!);
}
console.log("return", memberText(), String(rootText()));

function typeofText(value: unknown): string {
  return typeof value;
}
console.log("typeof", typeofText(lying["missing"]!), typeofText(nullable["missing"]!));
