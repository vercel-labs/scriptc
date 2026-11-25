// A generic function over a list that mixes the entries of constant tables
// with values read through their interface. The instance binds T to an array
// of a union: one arm per table entry layout and the interface's own. The
// checker types the loop variable by the constraint (the interface), which
// is a view every arm satisfies, not a narrowing: each element is read in
// the layout it has. The entries hold primitive constructors as values
// (String, Number, Boolean, a one-element list), which keep their identity,
// their `typeof` and their call through every read.
type Caster = typeof String | typeof Number | typeof Boolean;

interface Column {
  readonly title: string;
  readonly unit: string | null;
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
const paid = { title: "paid", unit: null, cast: Boolean, hidden: false, note: "settled", legacy: "p" } as const;
const tags = { title: "tags", unit: null, cast: [String], hidden: true } as const;
const owner = { title: "owner", unit: null, cast: String, hidden: false, note: "who" } as const;

const ledger = { name: "ledger", columns: [price, paid, tags] } as const;
const roster = { name: "roster", columns: [owner, paid] } as const;
const archive: Sheet = {
  name: "archive",
  columns: [],
  tabs: [
    {
      name: "audit",
      columns: [
        { title: "seen", unit: null, cast: Boolean, hidden: false, legacy: "s" },
        { title: "count", unit: "rows", cast: Number, hidden: false, note: "how many" },
        { title: "marks", unit: null, cast: [String, Number], hidden: true },
      ],
    },
    { name: "empty", columns: [] },
  ],
};

function casters<T extends ReadonlyArray<Column>>(columns: T): Record<string, unknown> {
  const out: Record<string, any> = {};
  for (const column of columns) {
    out[column.title] = column.cast;
    if (column.unit) out[`${column.title}.unit`] = column.unit;
    if (column.legacy) out[`old.${column.legacy}`] = column.title;
    if (column.hidden) out[`${column.title}.hidden`] = column.note ?? "no note";
  }
  return out;
}

function show(what: string, table: Record<string, unknown>): void {
  for (const key of Object.keys(table)) {
    const value = table[key];
    const name =
      value === Boolean
        ? "Boolean"
        : value === Number
          ? "Number"
          : value === String
            ? "String"
            : Array.isArray(value)
              ? `list of ${value.length}, first ${value[0] === String ? "String" : "other"}`
              : String(value);
    console.log(what, key, typeof value, name, typeof value === "function" ? value("12") : "-");
  }
}

show(
  "mixed",
  casters([...ledger.columns, ...(archive.tabs ?? []).flatMap((tab) => tab.columns), ...roster.columns]),
);
show("constant", casters(ledger.columns));
show("interface", casters(archive.tabs![0]!.columns));
show("one of each", casters([owner, ...archive.tabs![0]!.columns]));
show("none", casters([...archive.columns, ...archive.tabs![1]!.columns]));
