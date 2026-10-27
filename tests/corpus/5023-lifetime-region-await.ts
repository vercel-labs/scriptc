// LifetimeRegion (@scriptc/experimental) across await: an async callback
// keeps allocating in its region after it resumes, so a region per request
// holds the whole request's graph and frees it once released. Requests run
// concurrently and interleave at every await; continuations nest other
// regions, reject, release their region while still pending, spawn work
// that outlives the request, and return objects that escape into a cache.
// Node.js prints the same.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Token implements ProgramLifetime {
  readonly text: string;
  readonly pos: number;
  constructor(text: string, pos: number) {
    this.text = text;
    this.pos = pos;
  }
}

class Node implements ProgramLifetime {
  readonly token: Token;
  readonly kids: Node[] = [];
  parent: Node | undefined = undefined;
  readonly attrs = new Map<string, string>();
  constructor(token: Token) {
    this.token = token;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function tokenize(source: string): Token[] {
  return source.split(" ").map((text, i) => new Token(text, i));
}

async function parse(tokens: Token[]): Promise<Node> {
  const root = new Node(tokens[0]!);
  for (let i = 1; i < tokens.length; i++) {
    if (i % 3 === 0) await turn();
    const node = new Node(tokens[i]!);
    node.parent = root;
    node.attrs.set("pos", `${tokens[i]!.pos}`);
    root.kids.push(node);
  }
  return root;
}

function render(root: Node): string {
  return `${root.token.text}(${root.kids.map((k) => `${k.token.text}@${k.attrs.get("pos")}`).join(" ")})`;
}

async function handle(id: number, source: string): Promise<string> {
  const tokens = tokenize(source);
  await tick();
  const root = await parse(tokens);
  await Promise.resolve();
  // Children spawned after a resume run in the region too.
  const sizes = await Promise.all(root.kids.map(async (kid) => {
    await turn();
    const copy = new Node(kid.token);
    copy.parent = kid;
    return copy.token.text.length;
  }));
  return `#${id} ${render(root)} sizes=${sizes.join(",")}`;
}

async function serve(id: number, source: string): Promise<string> {
  const region = new LifetimeRegion();
  try {
    return await region.run(() => handle(id, source));
  } finally {
    region.release();
  }
}

// A sync generator driven by a resumed continuation.
function* chain(tokens: Token[]): Generator<Node> {
  let prev: Node | undefined;
  for (const token of tokens) {
    const node = new Node(token);
    node.parent = prev;
    prev = node;
    yield node;
  }
}

async function nested(): Promise<string> {
  const outer = new LifetimeRegion();
  const inner = new LifetimeRegion();
  const result = await outer.run(async () => {
    const before = new Node(new Token("outer", 0));
    await tick();
    const local = inner.run(() => new Node(new Token("inner-sync", 1)));
    const later = await inner.run(async () => {
      await turn();
      const n = new Node(new Token("inner-async", 2));
      n.parent = local;
      return n;
    });
    const after = new Node(new Token("after", 3));
    after.parent = before;
    after.kids.push(local, later);
    const gen = [...chain(tokenize("g0 g1 g2"))];
    return `${after.parent.token.text} ${after.kids.map((k) => k.token.text).join("+")} ${later.parent!.token.text} ${gen.at(-1)!.parent!.token.text}`;
  });
  inner.release();
  outer.release();
  return result;
}

async function rejects(): Promise<string> {
  const region = new LifetimeRegion();
  try {
    await region.run(async () => {
      const node = new Node(new Token("doomed", 0));
      await tick();
      node.kids.push(new Node(new Token("child", 1)));
      throw new Error(`failed after ${node.kids.length} child`);
    });
    return "no error";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    region.release();
  }
}

async function releasedWhilePending(): Promise<string> {
  const region = new LifetimeRegion();
  const pending = region.run(async () => {
    const first = new Node(new Token("first", 0));
    await tick();
    // The region was released meanwhile; the work still allocates in it.
    const second = new Node(new Token("second", 1));
    second.parent = first;
    await turn();
    return `${second.parent.token.text}>${second.token.text}`;
  });
  region.release();
  return await pending;
}

// Background work started in a request outlives it.
let background: Promise<string> | undefined;
async function outlives(): Promise<string> {
  const region = new LifetimeRegion();
  const text = await region.run(async () => {
    const node = new Node(new Token("request", 0));
    background = (async (): Promise<string> => {
      await tick();
      await tick();
      const late = new Node(new Token("late", 1));
      late.parent = node;
      return `${late.parent.token.text}<-${late.token.text}`;
    })();
    await turn();
    return node.token.text;
  });
  region.release();
  return text;
}

// A result that escapes the request into a module-level cache keeps the
// region allocated until the cache lets go of it.
const cache = new Map<string, Node>();
async function escapes(key: string): Promise<string> {
  const region = new LifetimeRegion();
  const node = await region.run(async () => {
    await turn();
    const n = new Node(new Token(key, 0));
    n.kids.push(new Node(new Token(`${key}-kid`, 1)));
    return n;
  });
  region.release();
  cache.set(key, node);
  return `${node.token.text}/${node.kids[0]!.token.text}`;
}

async function main(): Promise<void> {
  const sources = ["let a = b + c ;", "fn f ( x ) { x }", "1 2 3 4 5 6 7", "if ( x ) y else z"];
  for (let round = 0; round < 2; round++) {
    const responses = await Promise.all(sources.map((s, i) => serve(round * 10 + i, s)));
    for (const r of responses) console.log(r);
  }
  console.log(await nested());
  console.log(await rejects());
  console.log(await releasedWhilePending());
  console.log(await outlives());
  console.log(await background);
  console.log(await escapes("cached"));
  console.log(cache.get("cached")!.kids[0]!.token.pos);
  cache.clear();
  // A later region, after the cache let go.
  console.log(await serve(99, "done ."));
}

main().catch((e) => {
  console.log("unexpected", String(e));
});
