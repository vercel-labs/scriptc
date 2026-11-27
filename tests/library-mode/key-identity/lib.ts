// A library build has no adoption unit: a dynamic value taken as a native
// collection key cannot keep its identity there, so the key conversion must
// refuse instead of storing a copy. `parse` reaches such a conversion on the
// JSON value it hands the internal store.
type Row = { id: number; tag: string };

function store(value: any): number {
  const rows = new Set<Row>();
  rows.add(value);
  return rows.size;
}

export function parse(json: string): number {
  return store(JSON.parse(json));
}
