// flatMap whose callback returns an array for some elements and something
// else for others. JavaScript decides per result: an array is spread one
// level, anything else is kept as one element. The compiler has no static
// plan for these mixes, so the runtime's flatMap makes the decision; the
// tables below are built at module level, as a package's lookup tables are.
const UNITS = { metre: { symbol: "m" }, second: { symbol: "s" }, count: {}, gram: { symbol: "g" } };

// A one-pair array or an empty array, over the entries of a table.
export const BY_SYMBOL = Object.fromEntries(
  Object.entries(UNITS).flatMap(([name, unit]) => ("symbol" in unit ? [[unit.symbol, name]] : [])),
);
export const NAMED = new Set(
  Object.entries(UNITS).flatMap(([name, unit]) => (unit.symbol ? [name] : [])),
);
console.log(BY_SYMBOL.m, BY_SYMBOL.s, BY_SYMBOL.g, BY_SYMBOL.x, Object.keys(BY_SYMBOL).join(","));
console.log([...NAMED].join(","), NAMED.has("count"));

const pairs = Object.entries(UNITS).flatMap(([name, unit]) =>
  "symbol" in unit ? [[unit.symbol, name]] : [],
);
console.log(JSON.stringify(pairs), pairs.length);
for (const [symbol, name] of pairs) console.log(symbol, name);
console.log(new Map(pairs).get("s"));

// A value or an array of values; only one level is spread.
const counts = [1, 2, 3, 4, 5];
console.log(JSON.stringify(counts.flatMap((n) => (n % 2 ? n : [n, n]))));
console.log(JSON.stringify(counts.flatMap((n) => (n > 3 ? [[n, [n]]] : "low"))));

// undefined, an object, null and an array, by index.
console.log(
  JSON.stringify(
    counts.flatMap((n, i) => (i === 0 ? undefined : i === 1 ? { n } : i === 2 ? null : [i])),
  ),
);

// Strings are kept whole; an empty array contributes nothing.
console.log(
  JSON.stringify(
    Object.keys(UNITS).flatMap((name) => (name.length > 4 ? [] : [name.toUpperCase(), name.length])),
  ),
);
const nested = Object.values(UNITS).flatMap((unit) => (unit.symbol ? [[unit.symbol]] : [[]]));
console.log(JSON.stringify(nested), nested.length);
