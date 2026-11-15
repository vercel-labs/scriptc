// Weak entries that end inside a collector pass, in collections that live on.
//
// A registry office files a record under each person. People come in
// families that name each other, so a dropped family is a cycle and its
// members die only when a collector pass frees them: every entry they are a
// key of ends inside that pass, while the office that holds the entries is
// alive and old. Records name other members of the family, a record can name
// the office's own annex (a second collection that dies in the same pass),
// and every tenth family is kept, so its entries must still answer at the
// end. Every seventh round forces a collector pass while the round's family
// is alive, which ages its annex ahead of the people who hold it.
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

class Person {
  id: number;
  kin: Person | null = null;
  annex: Annex | null = null;
  constructor(id: number) {
    this.id = id;
  }
}

class Entry {
  readonly about: Person;
  readonly kin: Person | null;
  readonly annex: Annex | null;
  constructor(about: Person, kin: Person | null, annex: Annex | null) {
    this.about = about;
    this.kin = kin;
    this.annex = annex;
  }
}

class Annex {
  readonly files: WeakMap<Person, Entry> = new WeakMap();
  readonly listed: WeakSet<Person> = new WeakSet();
  head: Person | null = null;
}

const office: WeakMap<Person, Entry> = new WeakMap();
const census: WeakSet<Person> = new WeakSet();
const kept: Array<Person> = [];
let sum = 0;

function family(n: number, size: number): Person {
  const head = new Person(n);
  const annex = new Annex();
  annex.head = head;
  head.annex = annex;
  let at = head;
  for (let i = 1; i < size; i++) {
    const next = new Person(n * 100 + i);
    at.kin = next;
    office.set(at, new Entry(at, next, i % 2 === 0 ? annex : null));
    annex.files.set(next, new Entry(next, at, null));
    annex.listed.add(at);
    census.add(next);
    at = next;
  }
  at.kin = head;
  office.set(at, new Entry(at, head, annex));
  census.add(head);
  return head;
}

function round(n: number): void {
  const head = family(n, 2 + (n % 6));
  if (n % 7 === 0) churn(200);
  sum += office.get(head)!.about.id === n ? 1 : 0;
  sum += census.has(head) ? 1 : 0;
  sum += head.annex!.listed.has(head) ? 1 : 0;
  if (n % 10 === 0) kept.push(head);
}

for (let i = 1; i <= 2000; i++) {
  round(i);
}
let found = 0;
let missed = 0;
for (const head of kept) {
  let at: Person = head;
  for (;;) {
    const entry = office.get(at);
    if (entry !== undefined && entry.about === at && census.has(at)) found++;
    else missed++;
    at = at.kin!;
    if (at === head) break;
  }
}
console.log('keys die in pass', sum, 'found', found, 'missed', missed);
