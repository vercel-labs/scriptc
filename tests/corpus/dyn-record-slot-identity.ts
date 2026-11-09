// An untyped object that reaches a typed record slot stays the one object it
// was: the typed name and the untyped name compare equal, and a write through
// either is read through the other. Each line is one way the value arrives
// (parsed text, a literal held as unknown, a spread copy) at one kind of slot.

interface Row {
  id: number;
  label: string;
  note?: string;
}

let held: Row = { id: 0, label: "" };

function take(row: Row): void {
  held = row;
}

class Base<P> {
  row: P;
  constructor(row: P) {
    this.row = row;
  }
}

class Keep extends Base<Row> {
  total: number;
  constructor(row: Row) {
    super(row);
    this.total = row.id + 1;
    held = row;
  }
}

interface Instance {
  row: unknown;
}

type Constructible = {
  new (row: unknown): Instance;
  readonly [key: string]: unknown;
};

function isConstructible(type: unknown): type is Constructible {
  return typeof type === "function";
}

function construct(type: unknown, row: unknown): Instance {
  if (!isConstructible(type)) {
    throw new TypeError("not a class");
  }
  return new type(row);
}

class Holder {
  row: Row = { id: 0, label: "" };
}

const sources: { [name: string]: () => unknown } = {
  parsed: () => JSON.parse('{"id":1,"label":"a","note":"n"}'),
  literal: () => {
    const made: unknown = { id: 1, label: "a", note: "n" };
    return made;
  },
  spread: () => {
    const base: Row = { id: 1, label: "a", note: "n" };
    return { ...base };
  },
  extra: () => JSON.parse('{"id":1,"label":"a","note":"n","extra":true}'),
  missing: () => JSON.parse('{"id":1,"label":"a"}'),
};

const slots: { [name: string]: (src: unknown) => Row } = {
  declaration: (src) => {
    const loose: any = src;
    const kept: Row = loose;
    return kept;
  },
  argument: (src) => {
    const loose: any = src;
    take(loose);
    return held;
  },
  "function slot": (src) => {
    const handler: (value: any) => void = take;
    handler(src);
    return held;
  },
  "untyped construction": (src) => {
    const made = construct(Keep, src);
    console.log("  the instance keeps it:", made.row === src);
    return held;
  },
  field: (src) => {
    const loose: any = src;
    const holder = new Holder();
    holder.row = loose;
    return holder.row;
  },
  returned: (src) => {
    const give = (): Row => {
      const loose: any = src;
      return loose;
    };
    return give();
  },
  pushed: (src) => {
    const loose: any = src;
    const rows: Row[] = [];
    rows.push(loose);
    return rows[0];
  },
};

for (const [slotName, slot] of Object.entries(slots)) {
  for (const [sourceName, source] of Object.entries(sources)) {
    const src = source();
    const loose: any = src;
    console.log(`${slotName}, ${sourceName}`);
    const kept = slot(src);
    console.log("  read:", kept.id, kept.label, kept.note);
    console.log("  identity:", (kept as unknown) === src);
    kept.label = "typed";
    console.log("  typed write, untyped read:", loose.label);
    loose.id = 7;
    console.log("  untyped write, typed read:", kept.id);
    console.log("  keys:", Object.keys(loose).join(","), JSON.stringify(kept));
  }
}
