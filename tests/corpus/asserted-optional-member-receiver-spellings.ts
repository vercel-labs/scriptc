// The asserted-only optional member read through the spellings that still
// name the binding: `(view).icons`, `((view)).icons`, `(view)!.icons` and
// `view!.icons`. Node erases the assertion in all of them, so each answers
// what the object carries — the value when the source has the key,
// undefined when it does not — and the binding keeps the layout it was built
// with.
interface Base {
  name: string;
}

const item = JSON.parse('{"name":"n","icons":["a"],"other":7}') as Base;
const bare = JSON.parse('{"name":"b"}') as Base;

// A const binding read through parentheses and the non-null assertion.
const view = item as Base & { icons?: unknown };
console.log("paren", String((view).icons), String(((view)).icons));
console.log("nonnull", String(view!.icons), String((view)!.icons));

// Through a function parameter, the way a helper takes the value.
function read(base: Base): string {
  const opts = base as Base & { icons?: unknown };
  return String((opts).icons) + "/" + String(opts!.icons);
}
console.log("fn", read(item), read(bare));

// A source without the key answers undefined in every spelling.
const missing = bare as Base & { icons?: unknown };
console.log("missing", String((missing).icons), String((missing)!.icons), String(missing!.icons));

// The assertion erases: keys, JSON and identity see the object the source
// produced, not a copy.
console.log("object", Object.keys(view).join(","), JSON.stringify(view), String(view === item));
