// An object of methods written for two records, put in a list of the
// interface instantiated with three through an assertion to the list's
// element type. The assertion adds nothing the list's type does not say, so
// the entry converts as an unasserted one does: a value built as the third
// record is read as the arm that declares the properties it has.
interface Strings {
  wound?: boolean;
  set?: string;
  gauge?: number;
}
interface Brass {
  valves?: number;
  set?: string;
  bore?: number;
}
interface Reed {
  cane?: number;
  set?: string;
  wound?: boolean;
  bore?: number;
}
type Fitting = Strings | Brass | Reed;

interface Case<F> {
  tag: string;
  fit?: F;
}
interface Tuner<F> {
  tune(item: Case<F>): string;
}

function stringsAndBrass(): Tuner<Strings | Brass> {
  return {
    tune(item) {
      const fit = item.fit;
      if (fit === undefined) return `${item.tag}: nothing fitted`;
      const family = "wound" in fit ? `strings wound=${fit.wound}` : "valves" in fit ? `brass valves=${fit.valves}` : "unknown";
      const bore = "bore" in fit ? ` bore=${fit.bore}` : "";
      return `${item.tag}: ${family}${bore} set=${fit.set ?? "none"} ${Object.keys(fit).length} ${JSON.stringify(fit)}`;
    },
  };
}

function reed(tag: string, fit?: Reed): Case<Fitting> {
  return { tag, fit };
}

const bench: Tuner<Fitting>[] = [stringsAndBrass() as Tuner<Fitting>];
const viola: Strings = { wound: true, set: "A", gauge: 0.6 };
const horn: Brass = { valves: 3, bore: 11.5 };
const cases: Case<Fitting>[] = [
  { tag: "viola", fit: viola },
  { tag: "horn", fit: horn },
  reed("oboe", { cane: 2 }),
  reed("oboe-b", { set: "B", bore: 4 }),
  reed("clarinet", { cane: 3, wound: false }),
  reed("empty", {}),
  reed("bare"),
];
for (const item of cases) console.log(bench[0]!.tune(item));
