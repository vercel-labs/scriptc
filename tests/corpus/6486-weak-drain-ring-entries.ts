// Rings of weak entries in a collection that dies on a cycle.
//
// Each cart files a tag under every crate it carries, and each tag names the
// next crate, the last one the first: no crate is held by anything but the
// tag of the crate before it, so the whole ring is dead as soon as the cart
// is, and freeing the cart's collection frees every key of the collection
// through the value of another entry, entries the walk has passed and
// entries it has yet to reach. Carts are parked for a while before they are
// dropped, so their collections are older than the crates filed last, and
// every seventh round forces a collector pass while the round's carts are
// alive, which ages their collections ahead of the carts.
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

class Crate {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class Tag {
  readonly next: Crate;
  weight: number;
  constructor(next: Crate, weight: number) {
    this.next = next;
    this.weight = weight;
  }
}

class Cart {
  readonly tags: WeakMap<Crate, Tag> = new WeakMap();
  readonly sealed: WeakSet<Crate> = new WeakSet();
  horse: Cart | null = null;
  loads: number = 0;
}

const parked: Array<Cart> = [];
let sum = 0;

function load(cart: Cart, n: number, length: number): void {
  const first = new Crate(n);
  let at = first;
  for (let i = 1; i <= length; i++) {
    const next = i === length ? first : new Crate(n + i);
    cart.tags.set(at, new Tag(next, i));
    if (i % 2 === 0) cart.sealed.add(at);
    at = next;
  }
  cart.loads++;
  sum += cart.tags.get(first)!.weight;
  sum += cart.sealed.has(first) ? 1 : 0;
}

function round(n: number): void {
  const cart = new Cart();
  const other = new Cart();
  cart.horse = other;
  other.horse = cart;
  load(cart, n, 1 + (n % 9));
  load(other, n, 3);
  if (n % 7 === 0) churn(200);
  const slot = n % 120;
  if (parked.length <= slot) parked.push(cart);
  else {
    load(parked[slot], n, 2 + (n % 5));
    if (n % 4 === 0) parked[slot] = cart;
  }
}

for (let i = 1; i <= 2500; i++) {
  round(i);
}
let loads = 0;
for (const cart of parked) loads += cart.loads;
console.log('ring entries', sum, loads);
