// `+=` on a member of a value held as the checked dynamic compiles for a
// member the checker types `number` or `string`. A member that may be either,
// and an untyped member with a string operand, are still refused, and the
// message names the member's type instead of the number the path assumes.
type Cell = { kind: "cell"; label: string | number };

function isCell(value: unknown): value is Cell {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "cell";
}

const parsed: unknown = JSON.parse('{"kind":"cell","label":"a"}');
if (isCell(parsed)) parsed.label += "b";

const loose: any = JSON.parse('{"text":"a"}');
loose.text += "b";
console.log(JSON.stringify(parsed), JSON.stringify(loose));
