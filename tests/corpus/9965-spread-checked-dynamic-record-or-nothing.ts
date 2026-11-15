// An object spread whose source is a checked-dynamic value that the checker
// types as a record or nothing: `fault?.beds && { … }`, where `fault` has an
// intersection type that is held as a checked-dynamic value, so the `&&` is
// one too. The source enters the record-or-undefined type through the
// checked conversion: a record spreads its keys in place, undefined spreads
// nothing, and the keys keep the literal's order.
type PlotFault = Error & { beds?: string[]; nearest?: string; rows?: number };

const marked = new WeakSet<Error>();

function isPlotFault(value: unknown): value is PlotFault {
  return value instanceof Error && marked.has(value);
}

function plotFault(message: string, beds?: string[], nearest?: string, rows?: number): PlotFault {
  const fault: PlotFault = new Error(message);
  if (beds) fault.beds = beds;
  if (nearest) fault.nearest = nearest;
  if (rows !== undefined) fault.rows = rows;
  marked.add(fault);
  return fault;
}

const keys = (o: object): string => Object.keys(o).join(",") + " " + JSON.stringify(o);

let reads = 0;
function bedsOf(fault: PlotFault | undefined): string[] | undefined {
  reads++;
  return fault?.beds;
}

function extraOf(fault: PlotFault | undefined, season: string) {
  return fault?.beds && { beds: fault.beds, season };
}

function report(error: unknown, season: string): string[] {
  const fault = isPlotFault(error) ? error : undefined;
  const held = fault?.beds && { beds: fault.beds, season };
  return [
    // last, first and in the middle of the literal
    keys({
      state: "failed" as const,
      text: error instanceof Error ? error.message : String(error),
      ...(fault?.beds && { beds: fault.beds, nearest: fault.nearest, season }),
    }),
    keys({ ...(fault?.beds && { beds: fault.beds, season }), state: "failed" as const }),
    keys({ state: "failed" as const, ...(fault?.beds && { beds: fault.beds, season }), after: 1 }),
    // over an earlier key, and under a later one
    keys({ season: "none", beds: ["x"], ...(fault?.beds && { beds: fault.beds, season }) }),
    keys({ ...(fault?.beds && { beds: fault.beds, season }), season: "late" }),
    // two sources, and a number as the condition
    keys({
      state: "failed" as const,
      ...(fault?.beds && { beds: fault.beds }),
      ...(fault?.nearest && { nearest: fault.nearest, season }),
    }),
    keys({ state: "failed" as const, ...(fault?.rows && { rows: fault.rows, season }) }),
    // the source held in a binding, returned from a function, and with a nested record
    keys({ state: "failed" as const, ...held }) + " " + String(held === undefined),
    keys({ state: "failed" as const, ...extraOf(fault, season) }),
    keys({
      state: "failed" as const,
      ...(fault?.beds && { plan: { beds: fault.beds, count: fault.beds.length }, season }),
    }),
    // the condition is evaluated once per literal
    keys({ state: "failed" as const, ...(bedsOf(fault) && { season, reads }) }),
  ];
}

const inputs: unknown[] = [
  plotFault("two beds", ["north", "south"], "south", 4),
  plotFault("one bed", ["north"]),
  plotFault("empty list", []),
  plotFault("no list"),
  plotFault("no rows", ["east"], undefined, 0),
  new Error("unmarked"),
  "text",
];
for (const input of inputs) {
  for (const line of report(input, "spring")) console.log(line);
  console.log("--");
}
console.log(reads);
