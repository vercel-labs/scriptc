// The non-null spelling of the asserted-only member write: `view!.icons = v`
// names the same member only the asserted type declares, and takes the same
// refusal — the binding holds a record whose layout has no slot for it.
interface Base {
  name: string;
}

const item = JSON.parse('{"name":"n"}') as Base;
const view = item as Base & { icons?: unknown };
view!.icons = ["z"];
console.log(String(view.icons), JSON.stringify(item));
