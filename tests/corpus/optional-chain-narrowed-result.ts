// An optional chain the checker narrowed as a whole. `typeof s?.interval ===
// "string"` proves the chain a string in one arm and `number | undefined` in
// the other, while the guarded read still answers the member's stored
// `string | number | undefined`. The chain's result holds the arms that are
// still possible.
type Settings = {
  id?: string;
  interval?: number | string;
  label?: string | null;
  mode?: "fast" | "slow" | 7;
  inner?: { depth?: number | boolean };
} | null;

// The conditional's false arm: the pi shape.
function seconds(s: Settings): number | undefined {
  return typeof s?.interval === "string" ? Number(s.interval.trim()) : s?.interval;
}

// The same narrowing across statements.
function text(s: Settings): string | undefined {
  if (typeof s?.interval === "number") return `#${s.interval}`;
  return s?.interval;
}

// A default behind the narrowed chain.
function described(s: Settings): string {
  return typeof s?.interval === "number" ? "number" : (s?.interval ?? "none");
}

// Narrowed by a literal comparison instead of typeof.
function mode(s: Settings): "slow" | 7 | undefined {
  if (s?.mode === "fast") return undefined;
  return s?.mode;
}

// Narrowed by excluding null: undefined stays possible.
function label(s: Settings): string {
  if (s?.label === null) return "null";
  const rest: string | undefined = s?.label;
  return rest ?? "missing";
}

// A two-step chain narrowed at its tail.
function depth(s: Settings): number | undefined {
  if (typeof s?.inner?.depth === "boolean") return s.inner.depth ? 1 : 0;
  return s?.inner?.depth;
}

// The element spelling of the same read.
function keyed(s: Settings): number | undefined {
  return typeof s?.["interval"] === "string" ? s["interval"].length : s?.["interval"];
}

class Holder {
  value: number | string | undefined;
  constructor(value: number | string | undefined) {
    this.value = value;
  }
}

// A class receiver.
function held(h: Holder | undefined): string | undefined {
  return typeof h?.value === "number" ? String(h.value * 2) : h?.value;
}

const inputs = [
  '{"interval":7}',
  '{"interval":" 5 "}',
  '{"interval":"x","label":null,"mode":"fast"}',
  '{"label":"L","mode":"slow","inner":{"depth":3}}',
  '{"mode":7,"inner":{"depth":true}}',
  '{"inner":{}}',
  "{}",
  "null",
];
for (const input of inputs) {
  const s = JSON.parse(input) as Settings;
  console.log(
    input,
    seconds(s),
    text(s),
    described(s),
    mode(s),
    label(s),
    depth(s),
    keyed(s),
  );
}
console.log(held(new Holder(21)), held(new Holder("kept")), held(new Holder(undefined)), held(undefined));

// The receiver evaluates once per chain, and the narrowed read keeps its place.
let reads = 0;
const counted = {
  get current(): Settings {
    reads++;
    return { interval: reads };
  },
};
const once = counted.current;
console.log(typeof once?.interval === "string" ? "string" : once?.interval, reads);
