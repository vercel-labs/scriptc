// A generic repository whose query candidates are an Iterable<T>: the
// live row map's values() iterator when nothing is indexed, or an array of
// index hits. Methods returning Iterable<T> keep the class compilable.

interface Row {
  readonly id: string;
  readonly tag: string;
  readonly n: number;
}

class Repository<T extends { readonly id: string }> {
  private readonly rows = new Map<string, T>();
  private readonly index = new Map<string, string[]>();

  private readonly key: (row: T) => string;

  constructor(key: (row: T) => string) {
    this.key = key;
  }

  insert(row: T): void {
    this.rows.set(row.id, row);
    const k = this.key(row);
    const ids = this.index.get(k);
    if (ids === undefined) this.index.set(k, [row.id]);
    else ids.push(row.id);
  }

  all(): Iterable<T> {
    return this.rows.values();
  }

  candidates(key: string | null): Iterable<T> {
    if (key === null) return this.rows.values();
    const out: T[] = [];
    for (const id of this.index.get(key) ?? []) {
      const row = this.rows.get(id);
      if (row !== undefined) out.push(row);
    }
    return out;
  }

  query(key: string | null, where: (row: T) => boolean): T[] {
    const matches: T[] = [];
    for (const row of this.candidates(key)) if (where(row)) matches.push(row);
    return matches;
  }
}

const repo = new Repository<Row>((row) => row.tag);
for (let i = 0; i < 12; i++) repo.insert({ id: `r${i}`, tag: i % 3 === 0 ? "red" : "blue", n: i * i });
console.log(repo.query(null, (r) => r.n > 50).map((r) => r.id).join(","));
console.log(repo.query("red", (r) => r.n % 2 === 0).map((r) => r.id).join(","));
console.log(repo.query("green", () => true).length, [...repo.all()].length);
let sum = 0;
for (const row of repo.candidates("blue")) sum += row.n;
console.log(sum, Array.from(repo.candidates(null)).slice(0, 2));
