// JSON.stringify's space parameter (replacer null), differentially vs Node —
// pretty output must be byte-exact: indentation depth per nesting level,
// newline placement, the space after ':', inline empty {} / [], dropped
// undefined-valued optional fields, and primitives (no structure to indent).
// Record fields serialize in DECLARED order (JS insertion order, exactly
// Node — 1880-json-declared-field-order pins the non-alphabetical cases);
// this file's alphabetical fields are historical layout, not load-bearing.

// Primitives: no structure, space is inert.
console.log(JSON.stringify(1, null, 2));
console.log(JSON.stringify("a:b,{c}", null, 2));
console.log(JSON.stringify(true, null, 4));

// Flat and nested records, number spaces.
const point = { label: "origin", x: 0, y: -1.5 };
console.log(JSON.stringify(point, null, 2));
console.log(JSON.stringify(point, null, 1));
console.log(JSON.stringify(point, null, 10));
const cfg = {
  debug: true,
  name: "svc",
  ports: [80, 443],
  server: { host: "example.com", port: 8080 },
};
console.log(JSON.stringify(cfg, null, 2));

// Arrays: nested, empty, and empty-inside-nonempty.
const grid: number[][] = [[1, 2], [], [3]];
console.log(JSON.stringify(grid, null, 2));
const none: string[] = [];
console.log(JSON.stringify(none, null, 2));

// Empty object inline; empty containers nested in records.
type Holder = { items: number[]; meta: { a?: number } };
const h: Holder = { items: [], meta: {} };
console.log(JSON.stringify(h, null, 2));

// Unions serialize as their arm; null arms print as null.
type MaybeNum = { v: number | null };
const mn: MaybeNum = { v: null };
console.log(JSON.stringify(mn, null, 2));
const mv: MaybeNum = { v: 3.5 };
console.log(JSON.stringify(mv, null, 2));

// Optional fields DROP while undefined — comma/newline placement must
// follow the survivors.
interface Opt {
  host: string;
  note?: string | null;
  port?: number;
}
const o1: Opt = { host: "h1" };
const o2: Opt = { host: "h2", note: null, port: 8080 };
const o3: Opt = { host: "h3", note: "n", port: undefined };
console.log(JSON.stringify(o1, null, 2));
console.log(JSON.stringify(o2, null, 2));
console.log(JSON.stringify(o3, null, 2));

// Strings containing JSON structure characters must NOT be re-indented.
const tricky = { s: '{"a":[1,2],"b":"x"}', t: "line\nbreak, \"quoted\": ok" };
console.log(JSON.stringify(tricky, null, 2));

// Number space clamping: fractional truncates, negative and 0 mean compact,
// >10 clamps to 10.
console.log(JSON.stringify(point, null, 2.9));
console.log(JSON.stringify(point, null, 0));
console.log(JSON.stringify(point, null, -3));
console.log(JSON.stringify(point, null, 99));

// String spaces: used verbatim, first 10 code units only; empty is compact.
console.log(JSON.stringify(cfg, null, "\t"));
console.log(JSON.stringify(point, null, "-->"));
console.log(JSON.stringify(mn, null, "0123456789abcdef"));
console.log(JSON.stringify(point, null, ""));

// Undefined space and the 2-argument form: all compact.
console.log(JSON.stringify(point, null, undefined));
console.log(JSON.stringify(point, null));
console.log(JSON.stringify(point, undefined, 2));

// The pretty result is an ordinary string.
const s = JSON.stringify(cfg, null, 2);
console.log(s.length, s.includes('  "debug": true'));

// Round-trip: pretty text parses back to the same value.
type Point = { label: string; x: number; y: number };
const back = JSON.parse(JSON.stringify(point, null, 2)) as Point;
console.log(back.label, back.x, back.y);
console.log(JSON.stringify(back, null, 2) === JSON.stringify(point, null, 2));

// A NUL ends Node's visible gap; a nonempty gap still inserts line breaks.
console.log(JSON.stringify(cfg, null, "\0tail"));
console.log(JSON.stringify(cfg, null, "x\0tail"));
console.log(JSON.stringify(cfg, null, "雪\t"));
console.log(JSON.stringify(tricky, null, "雪雪雪雪雪雪"));
