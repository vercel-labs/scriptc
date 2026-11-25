// A spread whose source is stored as `string | record | undefined` and that
// the checker narrowed to the record (the other branch of a typeof test, a
// guard clause, a type predicate). The record is copied, an absent element
// copies nothing, and the result keeps its own key order.
type Source = string | { source: string; extensions?: string[]; skills?: string[] };

function replaceAt(list: Source[], index: number, next: string): Source[] {
  const existing = list[index];
  const copy = [...list];
  copy[index] = typeof existing === "string" ? next : { ...existing, source: next };
  return copy;
}

function withSkills(entry: Source | undefined, skills: string[]): Source {
  if (typeof entry === "string") return { source: entry, skills };
  return { ...entry, source: entry?.source ?? "none", skills };
}

function isText(value: Source | null): value is string {
  return typeof value === "string";
}

function describe(value: Source | null): string {
  if (isText(value)) return `text:${value}`;
  const copy = { ...value, checked: true };
  return `record:${JSON.stringify(copy)}`;
}

type Step = number | { at: number; label?: string };
function shifted(steps: Step[], by: number): Step[] {
  return steps.map((step) => (typeof step === "number" ? step + by : { ...step, at: step.at + by }));
}

const list: Source[] = ["a", { source: "b", skills: ["s"] }, { source: "c", extensions: ["e"] }];
console.log(JSON.stringify(replaceAt(list, 0, "x")));
console.log(JSON.stringify(replaceAt(list, 1, "y")));
console.log(JSON.stringify(replaceAt(list, 2, "z")));
// Past the end: Node spreads nothing from undefined.
const grown = replaceAt(list, 5, "w");
console.log(grown.length, JSON.stringify(grown[5]), JSON.stringify(grown));
console.log(JSON.stringify(list));

console.log(JSON.stringify(withSkills("plain", ["k"])));
console.log(JSON.stringify(withSkills({ source: "rec", extensions: ["x"] }, ["k"])));
console.log(JSON.stringify(withSkills(undefined, [])));

console.log(describe("t"));
console.log(describe({ source: "s" }));
console.log(describe({ source: "s", extensions: ["own"] }));
console.log(describe(null));

console.log(JSON.stringify(shifted([1, { at: 2 }, { at: 3, label: "l" }], 10)));

// The copy is a new object: writes to it do not reach the source.
const original: Source = { source: "o", skills: ["a"] };
const replaced = replaceAt([original], 0, "p")[0];
if (typeof replaced !== "string") replaced.skills = ["b"];
console.log(JSON.stringify(original), JSON.stringify(replaced));
