// An intersection that restates a member with a separately written but
// structurally equal type maps as that one type. Restating an optional member
// as required makes it required; the checker keeps both element literals
// (`A[] & B[]`), and their arrays, tuples, and maps share one representation.

interface Options {
  root: string;
  files?: Array<{ path: string; size: number }>;
}
type Normalized = Options & { files: Array<{ path: string; size: number }> };

function normalize(options: Options): Normalized {
  return { ...options, files: options.files ?? [] };
}

function totalSize(n: Normalized): number {
  let total = 0;
  for (const f of n.files) total += f.size;
  return total;
}

const plain = normalize({ root: "/a" });
console.log(plain.root, plain.files.length, totalSize(plain));
const full = normalize({
  root: "/b",
  files: [
    { path: "x.txt", size: 3 },
    { path: "y.txt", size: 4 },
  ],
});
full.files.push({ path: "z.txt", size: 5 });
console.log(full.files.map((f) => f.path).join(","), totalSize(full));
console.log(JSON.stringify(full));

let maybe: Normalized | undefined;
if (process.argv.length < 99) maybe = { root: "/", files: [{ path: "a", size: 1 }] };
console.log(maybe?.root, maybe?.files[0]?.path);

// Nested records whose inner arrays are restated.
interface Settings {
  name: string;
  meta?: { tags: Array<{ key: string; value: string }> };
}
type Resolved = Settings & { meta: { tags: Array<{ key: string; value: string }> } };
const resolved: Resolved = { name: "s", meta: { tags: [{ key: "k", value: "v" }] } };
resolved.meta.tags.push({ key: "k2", value: "v2" });
for (const t of resolved.meta.tags) console.log(`${t.key}=${t.value}`);

// Tuples, nested arrays, and maps.
interface Layout {
  pair?: [{ x: number }, string];
  grid?: Array<Array<{ cell: number }>>;
  index?: Map<string, { hits: number }>;
}
type Filled = Layout & {
  pair: [{ x: number }, string];
  grid: Array<Array<{ cell: number }>>;
  index: Map<string, { hits: number }>;
};
const filled: Filled = {
  pair: [{ x: 7 }, "seven"],
  grid: [[{ cell: 1 }, { cell: 2 }], [{ cell: 3 }]],
  index: new Map([["home", { hits: 2 }]]),
};
filled.index.set("about", { hits: 1 });
console.log(filled.pair[0].x, filled.pair[1]);
console.log(filled.grid.map((row) => row.map((c) => c.cell).join("+")).join(" | "));
for (const [k, v] of filled.index) console.log(k, v.hits);

// Both sides required, and both sides optional (the member stays optional).
type Twice = { items: Array<{ n: number }> } & { items: Array<{ n: number }> };
const twice: Twice = { items: [{ n: 1 }, { n: 2 }] };
console.log(twice.items.reduce((s, i) => s + i.n, 0));
type BothOptional = { extra?: Array<{ n: number }> } & { extra?: Array<{ n: number }> };
const none: BothOptional = {};
const some: BothOptional = { extra: [{ n: 9 }] };
console.log(none.extra === undefined, some.extra?.[0]?.n);

// A restated member read through a function value.
type Handler = (event: Normalized) => string;
const describe: Handler = (event) => `${event.root}:${event.files.length}`;
console.log(describe(full), describe(plain));
