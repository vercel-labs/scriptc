// Record fields filled from array reads past the end hold undefined even
// though the declared field type is required. Copies, spreads, parameters
// and entry walks keep that undefined value and the property itself.

type Part = { sku: string; qty: number };
const parts: Part[] = [{ sku: "bolt", qty: 4 }];

const order: { main: Part; spare: Part } = { main: parts[0], spare: parts[3] };
console.log("source", order.spare === undefined, "spare" in order, order.main.sku);

const alias = order;
console.log("alias", alias.spare === undefined, alias.main.qty);
let moved = order;
moved = { main: parts[0], spare: parts[0] };
console.log("reassigned", moved.spare === undefined, moved.spare.sku);

const spread = { ...order };
console.log("spread", spread.spare === undefined, "spare" in spread, Object.keys(spread).join(","));
console.log("json", JSON.stringify(spread));
const extended = { ...order, note: "rush" };
console.log("extended", extended.spare === undefined, extended.note);

function describe(o: { main: Part; spare: Part }): string {
  return `${o.main.sku}/${o.spare === undefined ? "none" : o.spare.sku}`;
}
console.log("parameter", describe(order), describe({ main: parts[0], spare: parts[0] }));

for (const [key, value] of Object.entries(order)) {
  console.log("entry", key, value === undefined ? "missing" : value.sku);
}
console.log(
  "mapped",
  Object.entries(order)
    .map(([key, value]) => `${key}=${value === undefined ? "-" : value.qty}`)
    .join(" "),
);
console.log("counted", Object.entries(order).filter((pair) => pair[1] !== undefined).length);
Object.entries(spread).forEach(([key, value]) => console.log("spread entry", key, value === undefined));

// Fully present records keep their ordinary layout.
const full = { main: parts[0], spare: parts[0] };
const table = new Map(Object.entries(full));
console.log("present", table.size, Object.keys(Object.fromEntries(Object.entries(full))).join(","));
