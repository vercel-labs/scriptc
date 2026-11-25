// Destructuring a property only an ASSERTED intersection declares
// (`item as T & { icons?: unknown }` inside a generic instance): the
// assertion erases to the bound layout, which does not carry `icons`, but
// the value Node destructures may — a checked record keeps the source's
// undeclared properties, and a narrowed copy links to the record it came
// from. The binding reads the property when the value answers for it and
// is the type's undefined otherwise, so a default applies only to a value
// that lacks it.
interface Base {
  _meta?: unknown;
  name: string;
}

interface WithIcons {
  _meta?: unknown;
  name: string;
  icons?: unknown;
}

interface Wide {
  _meta?: unknown;
  name: string;
  icons: string[];
}

// The `_meta`-carrying pattern: the rest keeps the declared fields, and the
// asserted-only `icons` binds the value the object holds.
function listed<T extends Base>(item: T): string {
  const { _meta, icons: found, ...rest } = item as T & { icons?: unknown };
  return JSON.stringify(rest) + " meta=" + String(_meta) + " icons=" + String(found);
}

// A bound that already declares the property reads it like any other field.
function declared(item: WithIcons): string {
  const { icons } = item;
  return "declared=" + String(icons);
}

// A parsed value checked into the bound shape keeps its undeclared keys.
function parsed<T extends Base>(item: T): string {
  const { icons } = item as T & { icons?: unknown };
  return "parsed=" + String(icons);
}

// A narrowed copy keeps the record it came from, which has the property.
function narrowed<T extends Base>(item: T): string {
  const { icons } = item as T & { icons?: unknown };
  return "narrowed=" + String(icons);
}

function through(x: Base): string {
  return narrowed(x);
}

// The default applies exactly when the value lacks the property.
function defaulted<T extends Base>(item: T): string {
  const { icons = ["d"] } = item as T & { icons?: unknown };
  return "defaulted=" + JSON.stringify(icons);
}

const item = JSON.parse('{"name":"n","icons":["a"]}') as Base;
const bare = JSON.parse('{"name":"m"}') as Base;
console.log(listed(item));
console.log(listed(bare));
console.log(declared({ name: "n", icons: ["b"] }));
console.log(parsed(item));
console.log(parsed(bare));
const wide: Wide = { _meta: undefined, name: "w", icons: ["c"] };
console.log(through(wide));
console.log(defaulted(item));
console.log(defaulted(bare));
