// `+=` on a member the checker types `string`, on a value held as the checked
// dynamic: an `unknown` a predicate narrowed. It is the expanded
// `v.text = v.text + s`: the member is read once, validated as the string its
// type claims, appended to, and written back to the same object.
type Note = { kind: "note"; text: string; count: number; tag?: string };
type Tally = { kind: "tally"; total: number; unit: string };

function isNote(value: unknown): value is Note {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "note" &&
    typeof (value as { text?: unknown }).text === "string" &&
    typeof (value as { count?: unknown }).count === "number"
  );
}

function isTally(value: unknown): value is Tally {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "tally" &&
    typeof (value as { total?: unknown }).total === "number" &&
    typeof (value as { unit?: unknown }).unit === "string"
  );
}

const order: string[] = [];
function tail(label: string): string {
  order.push(label);
  return label;
}

function extend(value: unknown, more: string): string | undefined {
  if (isNote(value)) {
    // a string operand
    value.text += more;
    // the number form is unchanged
    value.count += 1;
    // a number operand appends its text
    value.text += value.count;
    // a boolean and a template operand
    value.text += value.count > 2;
    value.text += `<${more.length}>`;
    // the expression's own value is the appended string
    const result: string = (value.text += tail("!"));
    return result;
  }
  if (isTally(value)) {
    value.total += more.length;
    value.unit += more;
    // chained: the right operand's own compound runs first
    value.unit += (value.unit += tail("+"));
    return value.unit;
  }
  return undefined;
}

const parsed: unknown = JSON.parse(
  '[{"kind":"note","text":"ab","count":1},{"kind":"tally","total":1,"unit":"u"},{"kind":"other"},7,null]',
);
if (Array.isArray(parsed)) {
  for (const item of parsed) {
    console.log(extend(item, "cd"), extend(item, "ef"));
  }
}
// The writes landed on the parsed objects themselves.
console.log(JSON.stringify(parsed));
console.log(order.join(""));

// The same member through a nested value and a loop.
const doc: unknown = JSON.parse('{"notes":[{"kind":"note","text":"","count":0}]}');
const notes = (doc as { notes: unknown[] }).notes;
for (let i = 0; i < 3; i++) {
  for (const note of notes) {
    if (isNote(note)) note.text += String.fromCharCode(97 + i);
  }
}
console.log(JSON.stringify(doc));
