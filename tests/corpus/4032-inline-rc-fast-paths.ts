// @optimization: speed
// RC fast paths emitted inline: every mirrored family (strings, bytes,
// regexes, bigints, arrays, maps/sets, unions, closures, promises, class
// objects, capture boxes, dyn values) retained and released while another
// owner keeps it alive, then released for the last time. Covers both
// cycle-capable (headered) and acyclic objects of the per-object families,
// immortal literals flowing through fields, candidates re-buffered on every
// surviving release, and cycles left for the collector. Under SCRIPTC_SAN=1
// the runtime RC audit checks that every count balanced at exit.

type Node = { name: string; next: Node | null; tags: string[] };
type Shape = { kind: "circle"; r: number } | { kind: "square"; side: number };

class Account {
  label: string;
  history: number[];
  peers: Account[] = [];
  constructor(label: string) {
    this.label = label;
    this.history = [];
  }
}

function keep<T>(xs: T[], x: T): T {
  xs.push(x); // a second owner: later releases of the local survive
  return x;
}

function area(s: Shape): number {
  return s.kind === "circle" ? s.r * s.r * 3 : s.side * s.side;
}

async function settle(p: Promise<number>, extra: number): Promise<number> {
  const v = await p;
  return v + extra;
}

async function main(): Promise<void> {
  const literal = "immortal"; // interned literal: retains and releases are no-ops
  const strings: string[] = [];
  let joined = "";
  for (let i = 0; i < 300; i++) {
    const s = keep(strings, "s" + i); // heap string with two owners
    const t = i % 2 === 0 ? s : literal;
    joined = t.length > 3 ? joined + t[0] : joined;
  }
  strings.length = 10; // last releases of most strings
  console.log("strings", joined.length, strings.join(","));

  const bytes: Uint8Array[] = [];
  let byteSum = 0;
  for (let i = 0; i < 50; i++) {
    const b = keep(bytes, new Uint8Array([i, i + 1, i + 2]));
    const view = b.subarray(1); // the view owns its backing store
    byteSum += view[0] + view[1];
  }
  bytes.splice(0, 25);
  console.log("bytes", byteSum, bytes.length);

  const patterns: RegExp[] = [];
  let matches = 0;
  for (let i = 0; i < 40; i++) {
    const re = keep(patterns, new RegExp("a" + (i % 5) + "+"));
    if (re.test("xa" + (i % 5) + "a" + (i % 5))) matches++;
    const lit = /b+/g; // literal template, fresh state per evaluation
    if (lit.test("abbb")) matches++;
  }
  patterns.length = 0;
  console.log("regex", matches);

  const bigs: bigint[] = [];
  let big = 1n;
  for (let i = 0; i < 30; i++) big = keep(bigs, big * 3n + BigInt(i));
  console.log("bigint", big.toString().length, bigs.length);

  // Per-object families: acyclic arrays/maps (no header) next to arrays of
  // records that can point back at their owner (headered).
  const numbersByKey = new Map<string, number[]>();
  const nodes: Node[] = [];
  for (let i = 0; i < 200; i++) {
    const key = "k" + (i % 7);
    const list = numbersByKey.get(key) ?? [];
    list.push(i);
    numbersByKey.set(key, list);
    const node: Node = { name: key, next: nodes.length > 0 ? nodes[nodes.length - 1] : null, tags: [key] };
    keep(nodes, node);
  }
  const ring = nodes[0];
  ring.next = nodes[nodes.length - 1]; // a 200-node cycle through the array
  let walked = 0;
  let cursor: Node | null = ring;
  for (let i = 0; i < 450 && cursor !== null; i++) {
    walked += cursor.tags.length;
    cursor = cursor.next;
  }
  const seen = new Set<Node>(nodes.slice(0, 50));
  const owners: Array<Set<Node>> = [];
  for (let i = 0; i < 5; i++) keep(owners, seen).add(nodes[i]); // a headered set, shared
  nodes.length = 0; // the cycle is now garbage for the collector
  console.log("maps", numbersByKey.size, numbersByKey.get("k3")!.length, walked, seen.size, owners.length);

  const shapes: Shape[] = [];
  let total = 0;
  for (let i = 0; i < 120; i++) {
    const s: Shape = i % 3 === 0 ? { kind: "circle", r: i } : { kind: "square", side: i };
    const held = keep(shapes, s);
    total += area(held) + area(s);
  }
  shapes.splice(10);
  console.log("unions", total, shapes.length);

  const counters: Array<() => number> = [];
  for (let i = 0; i < 60; i++) {
    let n = i;
    const bump = keep(counters, () => (n += 2)); // a closure over a capture box
    bump();
  }
  let calls = 0;
  for (const c of counters) calls += c();
  counters.length = 5;
  console.log("closures", calls);

  const accounts: Account[] = [];
  for (let i = 0; i < 80; i++) {
    const a = keep(accounts, new Account("acct" + (i % 4)));
    a.history.push(i);
    if (accounts.length > 1) {
      const prev = accounts[accounts.length - 2];
      a.peers.push(prev);
      prev.peers.push(a); // mutual references: cycles among instances
    }
  }
  let peerCount = 0;
  for (const a of accounts) peerCount += a.peers.length;
  accounts.length = 0;
  console.log("objects", peerCount);

  const Local = class {
    v: number;
    constructor(v: number) {
      this.v = v;
    }
  };
  const classes: Array<typeof Local> = [];
  let made = 0;
  for (let i = 0; i < 20; i++) made += new (keep(classes, Local))(i).v;
  console.log("classes", made, classes.length);

  const pending: Promise<number>[] = [];
  for (let i = 0; i < 30; i++) keep(pending, settle(Promise.resolve(i), 1));
  const settled = await Promise.all(pending);
  console.log("promises", settled.reduce((a, b) => a + b, 0));

  const parsed: unknown[] = [];
  let dynTotal = 0;
  for (let i = 0; i < 40; i++) {
    const d = keep(parsed, JSON.parse('{"a":[' + i + "," + (i + 1) + "]}") as unknown);
    const typed = d as { a: number[] };
    dynTotal += typed.a[0] + typed.a[1];
  }
  parsed.length = 0;
  console.log("dyn", dynTotal);
}

main().then(() => console.log("done"));
