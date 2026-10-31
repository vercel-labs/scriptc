// Object.entries/keys/values over a UNION of records (the pi runtime's
// `cond ? fixedRecord : Record<string, T>` shape): each arm is enumerated
// by its own static walk — the union's runtime tag picks it — and the
// answer is the checker's one array type. The consumers are real code's:
// destructuring `.map(([k, v]) => ...)` and `new Map(entries)`.
type Fixed = { alpha: string; beta: string };
type Open = Record<string, string>;

function open(n: number): Open {
  const r: Open = {};
  r["k" + String(n)] = "v" + String(n);
  r.z = "last";
  return r;
}

function pick(which: number): Fixed | Open {
  if (which === 0) return { alpha: "one", beta: "two" };
  return open(which);
}

const whichList = [0, 1];
for (const which of whichList) {
  const defs = pick(which);
  const entries = Object.entries(defs);
  console.log("entries", which, entries.length, entries.map(([k, v]) => k + "=" + v).join("|"));
  console.log("keys", which, Object.keys(defs).join("|"));
  console.log("values", which, Object.values(defs).join("|"));
  const m = new Map(entries.map(([k, v]) => [k, v]));
  console.log("map", which, m.size, String(m.get("alpha")), String(m.get("z")));
}
