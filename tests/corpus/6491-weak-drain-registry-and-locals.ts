// Collections that die by their count, beside ones that die on a cycle, and
// a FinalizationRegistry's tokens.
//
// A porter carries a local WeakMap, a local WeakSet and a registry for one
// round; the trunk filed in them is held by its own label. The same trunk is
// filed with a pair of porters' lodges that hold each other, and registered
// with a registry that a lodge owns, with itself or its label as the token.
// So one key ends entries in a collection released by its last reference, in
// collections freed by a collector pass, and in a registry's token table,
// in the same round. Every eleventh round forces a collector pass while the
// round's collections are alive, which ages them ahead of the lodges.
class Mote {
  other: Mote | null = null;
}

// Dead two-object cycles: enough of them make the collector run a pass over
// the young objects while the caller's locals are alive.
function churn(n: number): void {
  for (let i = 0; i < n; i++) {
    const a = new Mote();
    const b = new Mote();
    a.other = b;
    b.other = a;
  }
}

class Trunk {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}

class Label {
  readonly trunk: Trunk;
  text: string;
  constructor(trunk: Trunk, text: string) {
    this.trunk = trunk;
    this.text = text;
  }
}

class Lodge {
  readonly stored: WeakMap<Trunk, Label> = new WeakMap();
  readonly claims: FinalizationRegistry<number> = new FinalizationRegistry<number>((_n: number) => {});
  other: Lodge | null = null;
  count: number = 0;
}

const station: FinalizationRegistry<number> = new FinalizationRegistry<number>((_n: number) => {});
let sum = 0;

function round(n: number): void {
  const trunk = new Trunk(n);
  const label = new Label(trunk, 't' + n);
  const local: WeakMap<Trunk, Label> = new WeakMap();
  const once: WeakSet<Trunk> = new WeakSet();
  local.set(trunk, label);
  once.add(trunk);
  const a = new Lodge();
  const b = new Lodge();
  a.other = b;
  b.other = a;
  a.stored.set(trunk, label);
  b.stored.set(trunk, new Label(trunk, 'copy'));
  a.claims.register(trunk, n, trunk);
  b.claims.register(trunk, n, label);
  station.register(trunk, n, label);
  if (n % 11 === 0) churn(200);
  if (n % 2 === 0) sum += a.claims.unregister(trunk) ? 1 : 0;
  if (n % 3 === 0) sum += station.unregister(label) ? 1 : 0;
  sum += local.get(trunk)!.text.length;
  sum += once.has(trunk) && a.stored.has(trunk) && b.stored.has(trunk) ? 1 : 0;
  a.count = sum % 7;
}

for (let i = 1; i <= 3000; i++) {
  round(i);
}
console.log('registry and locals', sum);
