// Object.entries / Object.values over a record whose DECLARED value type is
// a union of record layouts: the checker types the enumerated element as the
// declared union, while each field of the (generic) record carries only the
// layout it was written with — `{ kind: "counter"; description; unit?;
// attributes }` beside the histogram shape that adds its bucket hints. A
// field therefore has to widen into the element union by copying into ONE
// arm; the arms differ only in a field the value does not carry, so every
// read answers the same value whichever tag the box holds.

interface AttributeSpec {
  type: string;
  description: string;
  required?: boolean;
}

// The declared layout is one shared record intersected with the layout
// discriminant — the shape a metric/option table uses — so the union's arms
// repeat every shared field and differ only by the optional one.
type MetricSpec = {
  description: string;
  unit?: string;
  attributes: Record<string, AttributeSpec>;
} & ({ kind: string; bucketHint?: never } | { kind: string; bucketHint?: readonly number[] });

type Schema = { version: number; specs: Record<string, MetricSpec> };

function describe<const S extends Schema>(schema: S): string {
  const lines: string[] = [`v${schema.version}`];
  for (const [name, spec] of Object.entries(schema.specs ?? {})) {
    const attributes = spec.attributes;
    const names = Object.getOwnPropertyNames(attributes).sort();
    lines.push(`${name}:${spec.kind}:${spec.unit ?? "-"}:${names.join("+")}`);
  }
  for (const spec of Object.values(schema.specs ?? {})) {
    lines.push(`desc:${spec.description}`);
  }
  return lines.join("\n");
}

const schema = {
  version: 3,
  specs: {
    requests: {
      kind: "counter",
      description: "requests served",
      attributes: { route: { type: "string", description: "route template", required: true } },
    },
    latency: {
      kind: "histogram",
      description: "request latency",
      unit: "ms",
      bucketHint: [5, 10, 25],
      attributes: {
        route: { type: "string", description: "route template", required: true },
        status: { type: "number", description: "status code" },
      },
    },
    queueDepth: { kind: "counter", description: "queued jobs", unit: "jobs", attributes: {} },
  },
};

console.log(describe(schema));
console.log(describe({ version: 1, specs: {} }));
console.log(describe({ version: 2, specs: { only: { kind: "histogram", description: "solo", attributes: {} } } }));
