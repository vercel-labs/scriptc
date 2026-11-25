// The keyed twin of asserted-optional-member-write.ts: `view["icons"] = v`
// names a member only the asserted type declares, with the same refusal
// (a literal key is the same property write; the exact spelling is what
// decides, not the syntax).
interface Base {
  name: string;
}

const item = JSON.parse('{"name":"n"}') as Base;
const view = item as Base & { icons?: unknown };
view["icons"] = ["z"];
console.log(String(view.icons), JSON.stringify(item));
