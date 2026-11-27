// A non-null asserted read of a checked-dynamic dictionary keeps its runtime
// value: a present key reads its number, and a missing key is undefined, so
// arithmetic, unary and Math uses compute NaN, String(), templates and JSON
// see undefined, and comparisons answer false, exactly as Node does. A plain
// (not asserted) read still answers undefined for a missing key.
function ops(target: unknown): void {
  const record = target as Record<string, number>;
  console.log("plus", String(record["v"]! + 1), String(record["v"]! * 2));
  console.log("minus", String(record["v"]! - 1), String(record["v"]! / 2));
  console.log("mod", String(record["v"]! % 2), String(record["v"]! ** 2));
  console.log("unary", String(-record["v"]!), String(+record["v"]!));
  console.log(
    "math",
    String(Math.abs(record["v"]!)),
    String(Math.floor(record["v"]!)),
    String(Math.max(record["v"]!, 3)),
  );
  console.log(
    "compare",
    String(record["v"]! < 10),
    String(record["v"]! > 10),
    String(record["v"]! === 7),
  );
  console.log(
    "string",
    `v=${record["v"]!}`,
    String(record["v"]!),
    String(JSON.stringify(record["v"]!)),
  );
  console.log("isNaN", String(Number.isNaN(record["v"]!)));
  let total = 5;
  total += record["v"]!;
  console.log("compound", String(total));
  let counter = record["v"]!;
  counter++;
  console.log("increment", String(counter));
}

console.log("== present");
ops({ v: 7 });
console.log("== missing");
ops({});

function doubled(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}

const counter: unknown = { hits: 10 };
doubled(counter, "hits", 5);
console.log("write", (counter as Record<string, number>).hits);

const absent: unknown = {};
console.log("probe", (absent as Record<string, number>).hits === undefined);

// JSON, typed arguments and null cells observe the runtime value too.
function missingJson(target: unknown): void {
  const record = target as Record<string, number>;
  console.log("json", String(JSON.stringify(record["v"]!)), JSON.stringify({ k: record["v"]! }));
  const toUnknown = (v: unknown): string => typeof v;
  console.log("typed", toUnknown(record["v"]!));
}

missingJson({});

function nullCell(target: unknown): void {
  const record = target as Record<string, number | null>;
  console.log(
    "null cell",
    record["cell"]! + 1,
    Math.abs(record["cell"]!),
    String(record["cell"]!),
  );
}

nullCell({ cell: null });
