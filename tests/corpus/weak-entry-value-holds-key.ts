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

const tags: WeakMap<Tree, Tag> = new WeakMap();
const grafts: WeakMap<Promise<number>, Graft> = new WeakMap();
const signs: WeakMap<object, Sign> = new WeakMap();
const pickers: WeakMap<() => number, {pick: () => number; n: number}> = new WeakMap();
const fences: WeakMap<object, unknown> = new WeakMap();
const marked: WeakSet<object> = new WeakSet();

const rounds = 12000;
const standing: Array<Tree> = [];
const standingGrafts: Array<Promise<number>> = [];
const standingPosts: Array<object> = [];
const standingPickers: Array<() => number> = [];
const first = new Tree(0);
tags.set(first, new Tag(first, 'first'));
let last: Tree = first;
let chained = 0;

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
