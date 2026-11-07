// A rest binding inside a generic function copies every own property the
// pattern did not name, and that includes the properties the type ARGUMENT
// adds beyond the constraint: the checker types the rest as `Omit<T, K>`
// and can only list the constraint's members, while the instance's binding
// names the value's real fields. The copy is typed by the binding.
interface Base {
  _meta?: unknown;
  name: string;
}

interface Wide extends Base {
  extra: number;
  notes?: { audience?: string[]; weight?: number };
}

interface Listing {
  uri: string;
  name: string;
  title?: string;
  size?: number;
  notes?: { audience?: string[] };
  _meta?: Record<string, unknown>;
}

// The constraint declares a member the pattern leaves in the rest.
function listed<T extends Base>(item: T): string {
  const { _meta, ...rest } = item;
  return JSON.stringify(rest) + " keys=" + Object.keys(rest).join(",");
}

// The constraint declares nothing but the consumed member, and the pattern
// also names a member only the assertion declares.
function tagged<T extends { _meta?: unknown }>(server: string, item: T): Record<string, unknown> {
  const { _meta, icons: _icons, ...rest } = item as T & { icons?: unknown };
  return { server, ...rest };
}

// The rest is the function's result: `Omit<T, "_meta">` at the call is the
// same record the body packs.
function strip<T extends Base>(item: T): Omit<T, "_meta"> {
  const { _meta, ...rest } = item;
  return rest;
}

// Every member the constraint declares is consumed; the binding's own
// members are what is left.
function others<T extends Base>(item: T): string {
  const { _meta, name, ...rest } = item;
  return name + ":" + JSON.stringify(rest);
}

const base: Base = { name: "b", _meta: 0 };
const wide: Wide = { name: "w", extra: 1, _meta: "m", notes: { audience: ["user"], weight: 2 } };
const bare: Wide = { name: "x", extra: 2 };
const listing: Listing = {
  uri: "u://a",
  name: "n",
  size: 3,
  notes: { audience: ["user"] },
  _meta: { k: 1 },
};

console.log(listed(base));
console.log(listed(wide));
console.log(listed(bare));
console.log(JSON.stringify(tagged("s", listing)));
console.log(JSON.stringify(tagged("t", wide)));
console.log(JSON.stringify(tagged("u", { _meta: 1 })));

const stripped = strip(wide);
console.log(JSON.stringify(stripped), stripped.extra, stripped.name, stripped.notes?.weight);
console.log(Object.keys(stripped).join(","));
console.log(JSON.stringify(strip(base)));

console.log(others(base));
console.log(others(wide));

// The copy is fresh: writes through it never reach the source.
const copy = strip(wide);
copy.extra = 9;
console.log(wide.extra, copy.extra);
