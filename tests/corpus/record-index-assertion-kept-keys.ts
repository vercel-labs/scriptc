// An index-signature record asserted to a record of its own keys is the
// same value in Node: the assertion is erased, so the keys the target does
// not declare stay observable through JSON.stringify, Object.keys and
// console output, and a write through the view reaches the record the
// program holds.

type Value = number | string;
type Colors = { accent: Value; border: Value };

function build(): Record<string, Value> {
  const colors: Record<string, Value> = {};
  colors["accent"] = "red";
  colors["border"] = 3;
  colors["extra"] = 7;
  return colors as Colors;
}

// The widened return keeps every key the record holds.
const colors = build();
console.log(colors["accent"], colors["border"], colors["extra"]);
console.log(JSON.stringify(colors), Object.keys(colors).join(","));

// Reads of the asserted fields answer the record's entries.
const view = colors as Colors;
console.log(view.accent, view.border);
console.log(JSON.stringify(view), Object.keys(view).join(","));

// A write through the view lands on the original record.
view.border = "blue";
console.log(colors["border"], JSON.stringify(colors), JSON.stringify(build()));

// A binding typed by the assertion keeps the value it names.
const narrowed: Colors = colors as Colors;
console.log(JSON.stringify(narrowed), narrowed.accent);

// The same inside a function body.
function rename(target: Record<string, Value>): string {
  const local = target as Colors;
  local.accent = "green";
  return JSON.stringify(target) + " " + JSON.stringify(local);
}
console.log(rename({ accent: "red", border: 1, extra: 2 }));
