// `const { k, ...rest } = src` over an INDEX-SIGNATURE source: the rest is
// a fresh object holding the entries Node's CopyDataProperties copies —
// the declared fields the pattern does not consume, then the overflow
// entries in JS own-key order minus the consumed keys. Values move by
// reference (the rest shares the source's nested objects), the result is a
// fresh object, and its prototype is Object.prototype even for a
// null-prototype source.
interface Cfg {
  a?: string;
  b?: number;
  [key: string]: unknown;
}

function pureRest(): void {
  const src: Record<string, string> = { q: "1", r: "2", s: "3" };
  const { q, ...rest } = src;
  console.log("pure:", q, JSON.stringify(rest), Object.keys(rest).join(","));
  rest.t = "4";
  console.log("fresh:", src.t === undefined, JSON.stringify(src));
  console.log("entries:", Object.entries(rest).map(([k, v]) => k + "=" + v).join(","));
  const seen: string[] = [];
  for (const k in rest) seen.push(k);
  console.log("for-in:", seen.join(","));
}

function presentUndefined(): void {
  const nums: Record<string, number | undefined> = { a: 1, b: undefined, c: 3 };
  const { a, ...rest } = nums;
  console.log(
    "undef:",
    a,
    JSON.stringify(rest),
    Object.keys(rest).join(","),
    "b" in rest,
    rest.b === undefined,
  );
}

function hybrid(): void {
  const cfg: Cfg = { a: "s", b: 2, x: 1 };
  const { a, x, ...rest } = cfg;
  console.log("hybrid:", JSON.stringify(rest), Object.keys(rest).join(","), rest.b);
  rest.y = 9;
  console.log("hybrid untouched:", cfg.y === undefined, Object.keys(cfg).join(","));
}

function integerKeys(): void {
  const table: Record<string, string> = {};
  table["10"] = "t";
  table["2"] = "u";
  table["z"] = "z";
  const { ...all } = table;
  console.log("ints:", Object.keys(all).join(","), JSON.stringify(all));
}

function nestedIdentity(): void {
  const nest: Record<string, Record<string, string>> = {
    env: { A: "1" },
    more: { B: "2" },
  };
  const { more, ...kept } = nest;
  console.log("identity:", kept.env === nest.env, JSON.stringify(more));
}

function nullProtoSource(): void {
  const grouped = Object.groupBy(["aa", "ab", "bc"], (s) => s.slice(0, 1));
  const { a, ...rest } = grouped;
  console.log(
    "groupBy:",
    a === undefined ? "none" : a.join(","),
    Object.keys(rest).join(","),
    Object.getPrototypeOf(rest) === Object.prototype,
  );
}

pureRest();
presentUndefined();
hybrid();
integerKeys();
nestedIdentity();
nullProtoSource();
