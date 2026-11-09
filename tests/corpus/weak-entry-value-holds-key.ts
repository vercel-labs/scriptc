// A WeakMap entry lasts while its key is alive without the entry's own value.
// An orchard files a tag under each tree, and every tag names its tree. Most
// trees are felled at once: nothing but their own tag holds them, so their
// entries may go. The others stay standing, some held only through the tag
// of another standing tree, and every one of them must still have its tag
// at the end, whatever the runtime dropped in between.

class Tree {
  readonly row: number;
  rings: Array<number>;
  constructor(row: number) {
    this.row = row;
    this.rings = [row, row + 1, row + 2];
  }
}

class Tag {
  readonly tree: Tree;
  readonly note: string;
  neighbour: Tree | null = null;
  constructor(tree: Tree, note: string) {
    this.tree = tree;
    this.note = note;
  }
}

class Graft {
  readonly ready: Promise<number>;
  state: string = 'waiting';
  constructor(ready: Promise<number>) {
    this.ready = ready;
  }
}

type Sign = {post: object; n: number};

// Keys of plain object types: a crate filed under itself, by its own type
// and as `object`, and kept in turn by a typed array, a class field, a wide
// array, and nothing but the label of another crate.
type Crate = {id: number; slats: Array<number>};
type Label = {crate: Crate; n: number; next: Crate | null};

class Shelf {
  readonly crate: Crate;
  readonly below: Shelf | null;
  constructor(crate: Crate, below: Shelf | null) {
    this.crate = crate;
    this.below = below;
  }
}

// Keys of a class type that are instances of a subclass.
class Crop {
  readonly plot: number;
  constructor(plot: number) {
    this.plot = plot;
  }
}

class Vine extends Crop {
  support: Crop | null = null;
}

const tags: WeakMap<Tree, Tag> = new WeakMap();
const grafts: WeakMap<Promise<number>, Graft> = new WeakMap();
const signs: WeakMap<object, Sign> = new WeakMap();
const pickers: WeakMap<() => number, {pick: () => number; n: number}> = new WeakMap();
const fences: WeakMap<object, unknown> = new WeakMap();
const marked: WeakSet<object> = new WeakSet();
const labels: WeakMap<Crate, Label> = new WeakMap();
const lids: WeakMap<object, Sign> = new WeakMap();
const yields: WeakMap<Crop, {crop: Crop; n: number}> = new WeakMap();

const rounds = 12000;
const standing: Array<Tree> = [];
const standingGrafts: Array<Promise<number>> = [];
const standingPosts: Array<object> = [];
const standingPickers: Array<() => number> = [];
const first = new Tree(0);
tags.set(first, new Tag(first, 'first'));
let last: Tree = first;
let chained = 0;
const standingCrates: Array<Crate> = [];
const wideCrates: Array<object> = [];
const standingVines: Array<Vine> = [];
let shelf: Shelf | null = null;
let shelved = 0;
const firstCrate: Crate = {id: 0, slats: []};
labels.set(firstCrate, {crate: firstCrate, n: 0, next: null});
let lastCrate: Crate = firstCrate;
let crateChain = 0;

for (let n = 1; n <= rounds; n++) {
  // A tree and its tag; one in sixteen stays standing.
  const tree = new Tree(n);
  tags.set(tree, new Tag(tree, 't' + n));
  if (n % 16 === 0) standing.push(tree);

  // One in eight is held by nothing but the tag of the previous such tree.
  if (n % 8 === 3) {
    tags.get(last)!.neighbour = tree;
    last = tree;
    chained++;
  }

  // A promise and the graft that waits on it.
  const ready: Promise<number> = Promise.resolve(n);
  grafts.set(ready, new Graft(ready));
  if (n % 32 === 0) standingGrafts.push(ready);

  // A parsed object, and a sign that points back at it.
  const parsed: unknown = JSON.parse('{"n":' + n + '}');
  const post = parsed as object;
  signs.set(post, {post, n});
  marked.add(post);
  if (n % 64 === 0) standingPosts.push(post);

  // A function filed under itself.
  const pick = (): number => n * 2;
  pickers.set(pick, {pick, n});
  if (n % 128 === 0) standingPickers.push(pick);

  // Two fences, each one's entry holding the other.
  const left: Sign = {post: tree, n};
  const right: Sign = {post: left, n};
  fences.set(left, right);
  fences.set(right, left);

  // A crate under its own type and as `object`; its lid names the crate.
  const crate: Crate = {id: n, slats: [n, n + 1]};
  labels.set(crate, {crate, n, next: null});
  lids.set(crate, {post: crate, n});
  if (n % 16 === 5) standingCrates.push(crate);
  if (n % 32 === 7) wideCrates.push(crate);
  if (n % 64 === 9) {
    shelf = new Shelf(crate, shelf);
    shelved++;
  }
  if (n % 8 === 1) {
    labels.get(lastCrate)!.next = crate;
    lastCrate = crate;
    crateChain++;
  }

  // A vine filed as a crop; its yield names it, and its support is the
  // vine before it.
  const vine = new Vine(n);
  yields.set(vine, {crop: vine, n});
  if (n % 16 === 11) {
    vine.support = standingVines.length > 0 ? standingVines[standingVines.length - 1] : null;
    standingVines.push(vine);
  }
}

let found = 0;
let wrong = 0;
for (const tree of standing) {
  const tag = tags.get(tree);
  if (tag !== undefined && tag.tree === tree && tag.note === 't' + tree.row) found++;
  else wrong++;
}
console.log('standing', standing.length, 'found', found, 'wrong', wrong);

let walked = 0;
let at: Tree | null = first;
while (at !== null) {
  const tag: Tag | undefined = tags.get(at);
  if (tag === undefined || tag.tree !== at) {
    wrong++;
    break;
  }
  walked++;
  at = tag.neighbour;
}
console.log('chain', chained + 1, 'walked', walked, 'wrong', wrong);

found = 0;
for (const ready of standingGrafts) {
  const graft = grafts.get(ready);
  if (graft !== undefined && graft.ready === ready && graft.state === 'waiting') found++;
  else wrong++;
}
console.log('grafts', standingGrafts.length, 'found', found, 'wrong', wrong);

found = 0;
for (const post of standingPosts) {
  const sign = signs.get(post);
  if (sign !== undefined && sign.post === post && marked.has(post)) found++;
  else wrong++;
}
console.log('posts', standingPosts.length, 'found', found, 'wrong', wrong);

found = 0;
let picked = 0;
for (const pick of standingPickers) {
  const entry = pickers.get(pick);
  if (entry !== undefined && entry.pick === pick) {
    found++;
    picked += entry.pick() - entry.n * 2;
  } else wrong++;
}
console.log('pickers', standingPickers.length, 'found', found, 'picked', picked, 'wrong', wrong);

found = 0;
for (const crate of standingCrates) {
  const label = labels.get(crate);
  const lid = lids.get(crate);
  if (label === undefined || label.crate !== crate || label.n !== crate.id) wrong++;
  else if (lid === undefined || lid.n !== crate.id) wrong++;
  else found++;
}
console.log('crates', standingCrates.length, 'found', found, 'wrong', wrong);

found = 0;
for (const wide of wideCrates) {
  const lid = lids.get(wide);
  if (lid !== undefined && lid.post === wide) found++;
  else wrong++;
}
console.log('wide crates', wideCrates.length, 'found', found, 'wrong', wrong);

found = 0;
for (let on: Shelf | null = shelf; on !== null; on = on.below) {
  const label = labels.get(on.crate);
  if (label !== undefined && label.crate === on.crate && label.n === on.crate.id) found++;
  else wrong++;
}
console.log('shelved', shelved, 'found', found, 'wrong', wrong);

walked = 0;
let crateAt: Crate | null = firstCrate;
while (crateAt !== null) {
  const label: Label | undefined = labels.get(crateAt);
  if (label === undefined || label.crate !== crateAt) {
    wrong++;
    break;
  }
  walked++;
  crateAt = label.next;
}
console.log('crate chain', crateChain + 1, 'walked', walked, 'wrong', wrong);

found = 0;
for (const vine of standingVines) {
  const filed = yields.get(vine);
  const support = vine.support;
  if (filed === undefined || filed.crop !== vine || filed.n !== vine.plot) wrong++;
  else if (support !== null && yields.get(support)?.crop !== support) wrong++;
  else found++;
}
console.log('vines', standingVines.length, 'found', found, 'wrong', wrong);

async function settle(): Promise<void> {
  let sum = 0;
  for (const ready of standingGrafts) {
    sum += await ready;
    const graft = grafts.get(ready);
    if (graft === undefined) wrong++;
    else graft.state = 'done';
  }
  let done = 0;
  for (const ready of standingGrafts) if (grafts.get(ready)?.state === 'done') done++;
  console.log('settled', sum, 'done', done, 'wrong', wrong);
}

settle().then(() => {
  console.log('end');
});
