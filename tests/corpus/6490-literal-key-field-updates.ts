// Read-modify-write through a key whose type is a union of literal field
// names (`totals[side] += n`): every compound operator, ++/-- and logical
// assignment dispatch over the declared fields the key can name. The
// receiver and key evaluate once, before the right side.
type Side = "sent" | "received";
interface Traffic {
  sent: number;
  received: number;
  label: string;
  updatedAt: number;
}

const traffic: Traffic = { sent: 0, received: 0, label: "link", updatedAt: 0 };

function record(side: Side, bytes: number): void {
  traffic[side] += bytes;
  traffic.updatedAt++;
}
record("sent", 120);
record("received", 64);
record("sent", 8);
console.log(JSON.stringify(traffic));

function adjust(side: Side): string {
  const parts: number[] = [];
  parts.push((traffic[side] -= 3));
  parts.push((traffic[side] *= 2));
  parts.push((traffic[side] /= 4));
  parts.push((traffic[side] %= 7));
  parts.push((traffic[side] **= 2));
  parts.push((traffic[side] |= 1));
  parts.push((traffic[side] &= 0xff));
  parts.push((traffic[side] ^= 0x0f));
  parts.push((traffic[side] <<= 2));
  parts.push((traffic[side] >>= 1));
  parts.push((traffic[side] >>>= 1));
  return parts.join(",");
}
console.log(adjust("sent"), adjust("received"));

// ++ and -- in statement and value positions, prefix and postfix.
const sides: Side[] = ["sent", "received", "sent"];
for (const s of sides) traffic[s]++;
for (const s of sides) --traffic[s];
const post = traffic[sides[1]!]--;
const pre = ++traffic[sides[0]!];
console.log(post, pre, traffic.sent, traffic.received);

// One literal key, spelled at the site or carried by a const.
traffic["sent"] += 1000;
const fixed = "received";
traffic[fixed] -= 1;
traffic["received"]++;
console.log(traffic.sent, traffic.received);

// Evaluation order: receiver, key, old value, right side, write.
let trace = "";
function pick(s: Side): Side {
  trace += `key:${s};`;
  return s;
}
function target(): Traffic {
  trace += "receiver;";
  return traffic;
}
function amount(n: number): number {
  trace += `rhs:${n};`;
  return n;
}
console.log((target()[pick("received")] += amount(5)), trace);
trace = "";
console.log(target()[pick("sent")]++, trace);
trace = "";
let current = traffic;
function swap(): number {
  current = { sent: -1, received: -1, label: "other", updatedAt: 0 };
  return 1;
}
current[pick("sent")] += swap();
console.log(traffic.sent, current.sent, trace);

// The right side throws after the old value is read: nothing is written.
function fail(): number {
  throw new Error("rhs failed");
}
try {
  traffic[pick("received")] *= fail();
} catch (e) {
  if (e instanceof Error) console.log(e.message, traffic.received);
}

// String fields append.
type Part = "head" | "tail";
const text: { head: string; tail: string; size: number } = { head: "a", tail: "z", size: 0 };
function append(p: Part, s: string): string {
  return (text[p] += s);
}
console.log(append("head", "bc"), append("tail", "yx"), append("head", "!"));
console.log(JSON.stringify(text));

// Optional fields with ??=: only a missing value takes the right side.
type Phase = "dns" | "connect" | "tls";
const timings: { dns?: number; connect?: number; tls?: number; total: number } = { total: 0 };
function mark(phase: Phase, at: number): number {
  return (timings[phase] ??= at);
}
console.log(mark("dns", 4), mark("connect", 9), mark("dns", 12), mark("tls", 0), mark("tls", 7));
console.log(timings.dns, timings.connect, timings.tls, timings.total);

// ||= and &&= test truthiness and write only in the selected branch.
const flags = { quiet: false, verbose: true, color: false };
type Flag = keyof typeof flags;
function settle(f: Flag, value: boolean): string {
  const a = (flags[f] ||= value);
  const b = (flags[f] &&= f !== "color");
  return `${f}:${a}:${b}`;
}
console.log(settle("quiet", true), settle("verbose", false), settle("color", true));
console.log(JSON.stringify(flags));

// Nested receivers and keys from a typed lookup.
const stats = { day: { hits: 1, misses: 2 }, week: { hits: 10, misses: 20 } };
type Window = keyof typeof stats;
type Outcome = "hits" | "misses";
const events: [Window, Outcome][] = [
  ["day", "hits"],
  ["week", "misses"],
  ["day", "misses"],
  ["day", "hits"],
];
for (const [w, o] of events) stats[w][o] += 1;
console.log(JSON.stringify(stats));
