// Keyed tables made from keyed tables, the way a catalog is built from
// grouped JSON data: Object.values over dictionaries of `object`, flattened
// with flatMap, filtered by a field, and keyed again with Object.fromEntries.
type Groups = Record<string, Record<string, object>>;

let seed = 4242;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const scale = Number(process.argv[2] ?? "1");
const kinds = ["part", "sketch", "label"];
const units = ["metric", "imperial", "nautical", "typographic", "kitchen", "survey"];

function generate(perGroup: number): string {
  const groups: Record<string, Record<string, unknown>> = {};
  let next = 0;
  for (const unit of units) {
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < perGroup; i++) {
      const pick = random();
      const kind = pick < 0.7 ? "part" : pick < 0.85 ? "sketch" : "label";
      const id = `${unit.slice(0, 2)}${next++}/item-${Math.floor(random() * 1000)}`;
      entries[`${kind}:${id}`] = {
        ...(kind === "part" ? {} : { kind }),
        id,
        label: `Item ${next}`,
        unit,
        size: 1 + Math.floor(random() * 64),
        tags: random() < 0.5 ? ["text"] : ["text", "image"],
        cost: { input: Math.floor(random() * 17), output: Math.floor(random() * 26) },
      };
    }
    groups[unit] = entries;
  }
  return JSON.stringify(groups);
}

function flatten(groups: Groups, kind: string): Record<string, object> {
  return Object.fromEntries(
    Object.values(groups)
      .flatMap((entries) => Object.values(entries))
      .filter((entry) => ((entry as { kind?: unknown }).kind ?? "part") === kind)
      .map((entry) => [(entry as { id: string }).id, entry]),
  );
}

const groups = JSON.parse(generate(400)) as Groups;
let tables = 0;
let keys = 0;
let longest = "";
for (let round = 0; round < Math.floor(60 * scale); round++) {
  for (const kind of kinds) {
    const table = flatten(groups, kind);
    tables++;
    for (const id of Object.keys(table)) {
      keys++;
      if (id.length > longest.length) longest = id;
    }
  }
}
// Every entry once more, through a chain that ends in a callback.
let entries = 0;
Object.values(groups)
  .flatMap((group) => Object.values(group))
  .filter((entry) => (entry as { kind?: unknown }).kind !== "label")
  .forEach(() => {
    entries++;
  });

console.log(`tables ${tables}, keys ${keys}, entries ${entries}, longest ${longest}`);
