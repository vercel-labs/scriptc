// A member write through a type assertion mutates the object the operand
// names: Node erases `as`. A view that declares a member the value's own
// layout does not hold has no slot to write, so the write would land on the
// assertion's converted copy and be dropped — refused instead of diverging.
interface Params {
  model: string;
}

function addOptionalMembers(params: Params): void {
  (params as { max_tokens?: number }).max_tokens = 10;
  (params as Params & { tool_stream?: boolean }).tool_stream = true;
}

function bumpThroughView(counts: { hits: number }): void {
  (counts as { hits: number; misses: number }).misses += 1;
}

// The `as unknown` link does not make the write dynamic either: it still
// names the value's own layout, which has no slot for `extra`.
function widen(bag: { a: number }): void {
  (bag as unknown as { a: number; extra?: string }).extra = "x";
}

addOptionalMembers({ model: "m" });
bumpThroughView({ hits: 0 });
widen({ a: 1 });
