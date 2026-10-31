// A type assertion from an index-signature record to a record of its own
// keys (`Record<string, V>` cast to `{ accent: V }`) is a CHECKED
// conversion: every claimed field is validated member by member, and the
// value's own keys survive — exactly the object Node hands on. The pair
// has no width copy (the index signature could hold a declared key at
// runtime), so it converts through the checked bridge instead of refusing.
// The generic form pins the instantiation path: a body returning
// `Record<keyof T, V>` converts when the caller's T settles the layout.
type V = number | string;
type Colors = { accent: V; border: V };

function direct(source: Record<string, V>): Colors {
  return source as Colors;
}

function filled(): Colors {
  const colors: Record<string, V> = {};
  colors["accent"] = "red";
  colors["border"] = 3;
  return colors as Colors;
}

function extraKeys(): Record<string, V> {
  const colors: Record<string, V> = {};
  colors["accent"] = "red";
  colors["border"] = 3;
  colors["extra"] = 7;
  return colors as Colors;
}

function genericTarget<T extends Record<string, V>>(colors: T): Record<keyof T, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(colors)) out[key] = value;
  return out as Record<keyof T, V>;
}

function genericSource<T extends Record<string, V>>(colors: T): Record<keyof T, V> {
  return colors as Record<keyof T, V>;
}

function report(colors: Colors): string {
  return `${colors.accent}/${colors.border}`;
}

console.log("direct", report(direct({ accent: "red", border: 3 })));
console.log("filled", JSON.stringify(filled()));
console.log("keys", Object.keys(filled()).join(","));
const wide = extraKeys();
console.log("extra", JSON.stringify(wide), Object.keys(wide).length);
console.log("generic target", JSON.stringify(genericTarget({ accent: "red", border: 3 })));
console.log("generic source", JSON.stringify(genericSource({ accent: "red", border: 3 })));
console.log("entries", JSON.stringify(Object.entries(genericTarget({ accent: "red", border: 3 }))));
