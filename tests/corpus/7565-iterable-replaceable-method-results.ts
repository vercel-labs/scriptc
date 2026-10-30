// A method returning Iterable<T> whose name an untyped write can replace
// (`holder.candidates = ...` through `any`) is called through the
// instance's property lookup: the native method runs while the slot is
// unchanged, and a replacement installed on an instance runs instead,
// its result iterated as an Iterable<T>.

interface Lookup {
  readonly index: string;
  readonly key: string;
}
interface Query {
  readonly lookups?: readonly Lookup[];
}
interface Row {
  id: string;
  n: number;
}

class Repo<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  add(row: T): void {
    this.rows.set(row.id, row);
  }
  candidates(lookups: readonly Lookup[]): Iterable<T> {
    if (lookups.length === 0) return this.rows.values();
    const out: T[] = [];
    for (const row of this.rows.values()) if (lookups.every((l) => l.key === row.id)) out.push(row);
    return out;
  }
  query(query: Query): T[] {
    const matches: T[] = [];
    for (const row of this.candidates(query.lookups ?? [])) matches.push(row);
    return matches;
  }
  ids(query: Query): string {
    let out = "";
    for (const row of this.candidates(query.lookups ?? [])) out += (out ? "," : "") + row.id;
    return out;
  }
}

function seed(): Repo<Row> {
  const r = new Repo<Row>();
  r.add({ id: "a", n: 1 });
  r.add({ id: "b", n: 2 });
  r.add({ id: "c", n: 3 });
  return r;
}

const r = seed();
console.log(r.query({}).length, r.query({ lookups: [{ index: "i", key: "b" }] }));
console.log(r.ids({}), r.ids({ lookups: [{ index: "i", key: "c" }] }));

// An untyped write of the same name: on an unrelated object first, then
// on one Repo instance, whose own property shadows the class method.
const holder: any = {};
holder.candidates = (): Row[] => [];
console.log(typeof holder.candidates);

const replaced = seed();
const untyped: any = replaced;
untyped.candidates = function (lookups: readonly Lookup[]): Row[] {
  return [{ id: "z" + lookups.length, n: 9 }];
};
console.log(replaced.query({}), replaced.query({ lookups: [{ index: "i", key: "a" }] }));
console.log(replaced.ids({}));

// A generator replacement is single-pass, as in JavaScript.
untyped.candidates = function* (): Generator<Row, void, undefined> {
  yield { id: "g1", n: 10 };
  yield { id: "g2", n: 11 };
};
console.log(replaced.query({}).map((row) => row.id + ":" + row.n));

// The untouched instance still runs the class method.
console.log(r.ids({}));
