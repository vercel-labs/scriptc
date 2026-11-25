// `const [a, b] = pair ?? []` binds the tuple's positions or, from the empty
// array, undefined (tests/corpus/9396-destructure-tuple-or-empty.ts). These
// neighbours keep a refusal: the empty literal has no element type the
// pattern's rest array or nested pattern could take, and an array operand
// under a conditional gives the literal no array type to adopt.
const corners: Record<string, [string, number]> = { top: ["t", 1] };

// A rest element collects what is left: an array of nothing, or of the tuple's tail.
function rest(side: string): number {
  const [first, ...others] = corners[side] ?? [];
  return others.length + (first ?? "").length;
}

// A nested pattern destructures a position that may be undefined.
const boxes: Record<string, [string, [number, number]]> = { top: ["t", [1, 2]] };
function inner(side: string): number {
  const [, [low, high]] = boxes[side] ?? [];
  return low + high;
}

// An array operand under a conditional.
function listed(list: string[] | undefined): string {
  const [head, next] = list ? list : [];
  return `${head} ${next}`;
}

console.log(rest("top"), inner("top"), listed(["a", "b"]));
