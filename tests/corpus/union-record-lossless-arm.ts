// A record flowing into a union where several record arms can hold it by a
// width conversion: the arm that keeps every one of its fields is the
// value's own layout, widened, and wins over arms that drop fields.

interface FastOpts {
  fast?: boolean;
  strict?: boolean;
}
interface DepthOpts {
  depth?: number;
}
interface StrictOpts {
  strict?: boolean;
}

interface Wide {
  id: string;
  window: number;
  kind?: string;
  limit: number;
  opts?: FastOpts | DepthOpts | StrictOpts;
}

interface Judge {
  id: string;
  window: number;
  kind: string;
  opts?: StrictOpts;
}

interface Narrow {
  id: string;
  window: number;
  kind?: string;
  limit: number;
  opts?: FastOpts | DepthOpts;
}

function show(entry: Wide | Judge): string {
  const limit = "limit" in entry ? ` limit=${entry.limit}` : "";
  return `${entry.kind ?? "wide"} ${entry.id} window=${entry.window}${limit} ${JSON.stringify(entry.opts ?? null)}`;
}

const narrow: Narrow = { id: "n1", window: 4, limit: 2, opts: { depth: 3 } };
console.log(show(narrow));

const entries: (Wide | Judge)[] = [narrow, { id: "j1", window: 1, kind: "judge", opts: { strict: true } }];
const plain: Narrow = { id: "n2", window: 8, kind: "custom", limit: 5 };
entries.push(plain);
for (const entry of entries) console.log(show(entry));

let latest: Wide | Judge | undefined;
for (const item of [narrow, plain]) latest = item;
console.log(latest === undefined ? "none" : show(latest));

