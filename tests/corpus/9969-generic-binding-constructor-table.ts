// A spreadsheet: every sheet lists its columns in a constant table, and a
// column names the constructor that casts its cells (String, Number, Boolean,
// or a one-element list for a repeated cell). One list mixes columns taken
// from constant tables with columns read through the interface.
type Caster = typeof String | typeof Number | typeof Boolean;

interface Column {
  readonly title: string;
  readonly unit: string;
  readonly cast: Caster | ReadonlyArray<Caster>;
  readonly hidden: boolean;
  readonly note?: string;
  readonly legacy?: string;
}

interface Sheet {
  readonly name: string;
  readonly columns: ReadonlyArray<Column>;
  readonly tabs?: ReadonlyArray<Sheet>;
}

const price = { title: "price", unit: "eur", cast: Number, hidden: false, note: "net" } as const;
const paid = { title: "paid", unit: "", cast: Boolean, hidden: false, note: "settled", legacy: "p" } as const;
const tags = { title: "tags", unit: "", cast: [String], hidden: true } as const;
const owner = { title: "owner", unit: "", cast: String, hidden: false, note: "who" } as const;

const ledger = { name: "ledger", columns: [price, paid, tags] } as const;
const roster = { name: "roster", columns: [owner, paid] } as const;
const archive: Sheet = { name: "archive", columns: [], tabs: [ledger, roster] };

function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const column of columns) {
    out[column.title] = column.cast;
    if (column.unit) out[`${column.title}.unit`] = column.unit;
    if (column.legacy) out[`old.${column.legacy}`] = column.title;
  }
  return out;
}

function show(what: string, table: Record<string, unknown>): void {
  for (const key of Object.keys(table)) {
    const value = table[key];
    const name =
      value === Boolean ? "Boolean" : value === Number ? "Number" : value === String ? "String" : Array.isArray(value) ? `list of ${value.length}` : String(value);
    console.log(what, key, typeof value, name, typeof value === "function" ? value("12") : "-");
  }
}

show(
  "mixed",
  casters([...ledger.columns, ...(archive.tabs ?? []).flatMap((tab) => tab.columns), ...roster.columns]),
);
