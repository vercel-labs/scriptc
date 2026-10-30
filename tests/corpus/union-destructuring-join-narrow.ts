// Object patterns over a union whose arms type a field differently (or do
// not declare it), narrowed sources, and rest elements over a union.
interface Wide {
  kind: "wide";
  value: number;
  extra?: string;
}
interface Narrow {
  kind: "narrow";
  value: string;
  extra?: undefined;
}
type Item = Wide | Narrow;

// The joined read: `number | string`, `string | undefined`.
function read(item: Item): void {
  const { value, extra } = item;
  console.log(item.kind, String(value), String(extra));
}
read({ kind: "wide", value: 7, extra: "e" });
read({ kind: "narrow", value: "v" });

interface Delta {
  type: "delta";
  partial: { text: string };
  other: number;
}
interface Final {
  type: "final";
  partial: { text: number };
  tail: boolean;
}
interface Bare {
  type: "bare";
  other: number;
}
type Wire = Delta | Final | Bare;

// A rest element over a union packs each arm's own remaining fields.
function rest(event: Delta | Final): string {
  const { partial: _partial, ...kept } = event;
  return JSON.stringify(kept);
}
console.log(rest({ type: "delta", partial: { text: "t" }, other: 2 }));
console.log(rest({ type: "final", partial: { text: 3 }, tail: true }));

// A discriminant test and an `in` guard narrow the source; the pattern
// reads the arms the checker proved.
function narrowed(event: Wire): string {
  if (event.type === "delta") {
    const { partial, other } = event;
    return `tag:${partial.text}:${other}`;
  }
  if ("partial" in event) {
    const { partial } = event;
    return `in:${String(partial.text)}`;
  }
  return "none";
}
console.log(narrowed({ type: "delta", partial: { text: "t" }, other: 2 }));
console.log(narrowed({ type: "final", partial: { text: 3 }, tail: true }));
console.log(narrowed({ type: "bare", other: 4 }));

// An `in` guard alone narrows to a SUB-union: both remaining arms keep
// their own field types.
function inOnly(w: Wire): string {
  if (!("partial" in w)) return "none";
  const { partial } = w;
  return String(partial.text);
}
console.log(inOnly({ type: "delta", partial: { text: "t" }, other: 2 }));
console.log(inOnly({ type: "final", partial: { text: 3 }, tail: true }));
console.log(inOnly({ type: "bare", other: 4 }));
