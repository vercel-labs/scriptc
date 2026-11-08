// A binding declared from a constant table with no type of its own is
// another name of the table: `const home = port` holds the table under the
// table's own type, and a pattern names its parts. The uses of such a
// binding are uses of the table, so the table still takes the layout of the
// interface it is read through, and the object a reader holds under any of
// the names is the one the collections hold.

interface Berth {
  readonly dock: string;
  readonly depth: number;
}

interface Harbor {
  readonly town: string;
  readonly berth: Berth;
  readonly spare?: Berth;
}

const quay = { dock: "quay", depth: 9 } as const;
const port = { town: "Lyme", berth: { dock: "cobb", depth: 4 }, spare: quay } as const;

const charted = new Set<Harbor>();
const berths = new Set<Berth>();

function chart(harbor: Harbor): void {
  charted.add(harbor);
  berths.add(harbor.berth);
  if (harbor.spare !== undefined) berths.add(harbor.spare);
}

function moored(berth: Berth): boolean {
  return berths.has(berth);
}

chart(port);

// The table under a second name, and its parts under names of their own: a
// primitive, a nested literal, another table.
const home = port;
const { town, berth, spare } = home;
let inner = berth;

console.log(charted.has(home), charted.has(port), town);
console.log(moored(berth), moored(inner), moored(spare), moored(quay));
console.log(spare === quay, inner === port.berth);
console.log(inner.dock, spare.depth, home.berth.depth);

// A name inside a function, and a name of a name.
function survey(): string {
  const local = home;
  const { berth: mooring } = local;
  return `${local.town}:${mooring.dock}:${String(charted.has(local))}:${String(moored(mooring))}`;
}
console.log(survey());

const { depth } = inner;
console.log(moored(home.berth), depth);
