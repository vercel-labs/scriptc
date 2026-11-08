// Pins: a spread copies every own key of its source in the source's order.
// A record that a checked conversion built keeps the keys its type does
// not declare beside it; spreading it into an index-signature record
// carries them, in the object's own order, like every other copy.
type Margins = { top: number; left: number };

function render(box: Record<string, number>): string {
  return Object.keys(box)
    .map((side) => `${side}:${box[side]}`)
    .join(" ");
}

const parsed = JSON.parse('{"right":4,"left":1,"top":2,"bottom":3}') as Margins;
console.log(parsed.left, parsed.top, Object.keys(parsed).join(" "));
console.log(render({ ...parsed }));
console.log(render({ ...parsed, gutter: 9 }));
console.log(render({ inset: 0, ...parsed, left: 5 }));

// The same record without undeclared keys, in another order than the type's.
const exact = JSON.parse('{"left":1,"top":2}') as Margins;
console.log(render({ ...exact, depth: 6 }));

// A literal has no kept source: its keys follow the literal.
const literal: Margins = { top: 2, left: 1 };
console.log(render({ ...literal, depth: 6 }));

// Two sourced records in one literal; later keys win and keep their first position.
const override = JSON.parse('{"top":20,"outline":8,"left":10}') as Margins;
console.log(render({ ...parsed, ...override }));

// A function that fills its record key by key, asserts it, and hands it on.
function uniform(sides: string[], width: number): Margins {
  const out: Record<string, number> = {};
  for (const side of sides) out[side] = width;
  return out as Margins;
}
console.log(render({ ...uniform(["bottom", "top", "left"], 7), extra: 1 }));

// Text values into a text-valued index record.
type Caption = { title: string; note: string };
function join(lines: Record<string, string>): string {
  return Object.keys(lines)
    .map((key) => `${key}=${lines[key]}`)
    .join(";");
}
const caption = JSON.parse('{"credit":"c","note":"n","title":"t"}') as Caption;
console.log(join({ ...caption, lang: "en" }));
