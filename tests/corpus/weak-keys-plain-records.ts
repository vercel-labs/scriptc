// A depot files papers under whatever object is handed in, so any plain
// record of the program can be the key of a weak entry. A parcel, its stamp,
// the slip that names it and the crate around it hold nothing but data: none
// of them can be on a cycle of its own, and the only way round is an entry
// whose value names its key. The depot files, drops and keeps such records
// every way they are freed: when the last holder lets go, when an entry's
// own value was the last holder of its key, and inside rings of garbage that
// also hold a callback. Every parcel still on a shelf must have its papers
// at the end, whatever was dropped in between.

type Stamp = {code: number; ink: string};
type Parcel = {id: number; stamp: Stamp; weights: Array<number>};
type Slip = {parcel: Parcel; stamps: Array<Stamp>; note: string};
type Folder = {slip: Slip; depth: number};

class Crate {
  readonly parcel: Parcel;
  readonly slips: Array<Slip>;
  label: string;
  constructor(parcel: Parcel, label: string) {
    this.parcel = parcel;
    this.slips = [];
    this.label = label;
  }
}

class Pallet extends Crate {
  spare: Slip | null = null;
}

// A ring holds itself through a wide slot and carries a callback; plain
// records hang off it.
type Ring = {self: unknown; slip: Slip; crate: Crate; count: () => number};

const folders: WeakMap<object, Folder> = new WeakMap();
const papers: WeakMap<object, unknown> = new WeakMap();
const sealed: WeakSet<object> = new WeakSet();
const manifests: WeakMap<Crate, Folder> = new WeakMap();
const owners: WeakMap<Parcel, Crate> = new WeakMap();

function stamp(n: number): Stamp {
  return {code: n, ink: 'ink' + (n % 7)};
}

function parcel(n: number): Parcel {
  return {id: n, stamp: stamp(n), weights: [n, n + 1, n + 2]};
}

function slip(of: Parcel, n: number): Slip {
  return {parcel: of, stamps: [stamp(n), of.stamp], note: 'slip ' + n};
}

const rounds = 1500;
const shelf: Array<Parcel> = [];
const wideShelf: Array<object> = [];
const yard: Array<Crate> = [];
const keptSlips: Array<Slip> = [];
const keptCrates: Array<Crate> = [];
let wrong = 0;
let counted = 0;

for (let n = 1; n <= rounds; n++) {
  // A parcel filed with the slip of another parcel: nothing leads back to
  // it, so its papers go when it is dropped at the end of the round.
  const loose = parcel(n);
  papers.set(loose, slip(parcel(n + rounds), n));
  sealed.add(loose);
  if (!papers.has(loose) || !sealed.has(loose)) wrong++;

  // A parcel whose folder names it two records down. One in sixteen stays
  // on the shelf, one in thirty-two on a shelf that only knows objects.
  const held = parcel(n * 3);
  folders.set(held, {slip: slip(held, n), depth: n % 5});
  if (n % 16 === 0) shelf.push(held);
  if (n % 32 === 1) wideShelf.push(held);

  // A slip filed under itself.
  const own = slip(parcel(n * 5), n);
  papers.set(own, own);
  if (papers.get(own) !== own) wrong++;

  // A crate filed by its class: the manifest names a slip the crate holds,
  // and the crate is filed under its own parcel, which it holds too.
  const crate: Crate = n % 3 === 0 ? new Pallet(parcel(n * 7), 'p' + n) : new Crate(parcel(n * 7), 'c' + n);
  crate.slips.push(slip(crate.parcel, n));
  if (crate instanceof Pallet) crate.spare = crate.slips[0];
  manifests.set(crate, {slip: crate.slips[0], depth: 1});
  owners.set(crate.parcel, crate);
  papers.set(crate, crate.slips);
  if (n % 64 === 2) yard.push(crate);

  // A ring nothing holds after this round, with a slip and a crate hanging
  // off it. The crate is filed under the slip's parcel, which it holds. One
  // slip in 128 and one crate in 256 outlive their ring.
  const ringSlip = slip(parcel(n * 11), n);
  const ring: Ring = {
    self: null,
    slip: ringSlip,
    crate: new Crate(ringSlip.parcel, 'r' + n),
    count: (): number => n,
  };
  ring.self = ring;
  ring.crate.slips.push(ringSlip);
  owners.set(ringSlip.parcel, ring.crate);
  counted += ring.count() - n;
  if (n % 128 === 5) keptSlips.push(ringSlip);
  if (n % 256 === 9) keptCrates.push(ring.crate);
}

let found = 0;
for (const held of shelf) {
  const folder = folders.get(held);
  if (folder === undefined || folder.slip.parcel !== held) wrong++;
  else if (folder.slip.note !== 'slip ' + held.id / 3 || folder.slip.stamps[1] !== held.stamp) wrong++;
  else found++;
}
console.log('shelf', shelf.length, 'found', found, 'wrong', wrong);

found = 0;
for (const held of wideShelf) {
  const folder = folders.get(held);
  if (folder !== undefined && folder.slip.parcel === held && folder.slip.stamps.length === 2) found++;
  else wrong++;
}
console.log('wide shelf', wideShelf.length, 'found', found, 'wrong', wrong);

found = 0;
let weight = 0;
for (const crate of yard) {
  const manifest = manifests.get(crate);
  const owner = owners.get(crate.parcel);
  if (manifest === undefined || manifest.slip !== crate.slips[0] || manifest.slip.parcel !== crate.parcel) wrong++;
  else if (owner !== crate || papers.get(crate) === undefined) wrong++;
  else if (crate instanceof Pallet && crate.spare !== manifest.slip) wrong++;
  else {
    found++;
    weight += crate.parcel.weights[2] + crate.label.length;
  }
}
console.log('yard', yard.length, 'found', found, 'weight', weight, 'wrong', wrong);

found = 0;
let inks = '';
for (const kept of keptSlips) {
  const owner = owners.get(kept.parcel);
  if (owner === undefined || owner.parcel !== kept.parcel || owner.slips[0] !== kept) wrong++;
  else found++;
  if (inks.length < 40) inks += kept.stamps[0].ink + ' ';
}
console.log('kept slips', keptSlips.length, 'found', found, 'inks', inks.trim(), 'wrong', wrong);

found = 0;
for (const kept of keptCrates) {
  const owner = owners.get(kept.parcel);
  if (owner === kept && kept.slips.length === 1 && kept.slips[0].parcel === kept.parcel) found++;
  else wrong++;
}
console.log('kept crates', keptCrates.length, 'found', found, 'counted', counted, 'wrong', wrong);
