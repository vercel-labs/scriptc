import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish, sharesPublishedGraphs } from "@scriptc/threads";

// @scriptc/threads publish(): a class graph (cycles, shared nodes, arrays,
// maps, sets, records) becomes immutable; in scriptc it is also immortal and
// workerData/postMessage share it by reference, while Node.js deep-freezes it
// and clones what it posts. Receivers publish() what they receive (a no-op in
// scriptc) and read only data, so both runtimes print the same thing.

class Leaf {
  name: string;
  weight: number;
  constructor(name: string, weight: number) {
    this.name = name;
    this.weight = weight;
  }
}

class Base {
  label: string;
  hits = 0;
  constructor(label: string) {
    this.label = label;
  }
  title(): string { return this.label; }
}

// Both contexts create their own default prototype. Publishing own storage
// must neither retain that context's prototype nor reject its method slot.
function untyped(value: Base): any { return value; }

function publishedDefault(label: string): string {
  const scratch: any = new Base("scratch");
  scratch.title = () => "shadow";
  const value = untyped(publish(new Base(label)));
  return `${value.title()} ${value.constructor === Base} ${"title" in value} ${value.missing}`;
}

class Tree extends Base {
  children: Tree[] = [];
  parent: Tree | undefined = undefined;
  tags = new Map<string, number>();
  kinds = new Set<string>();
  leaf: Leaf | undefined;
  span: { pos: number; end: number };
  constructor(label: string, leaf: Leaf | undefined, pos: number) {
    super(label);
    this.leaf = leaf;
    this.span = { pos, end: pos + 10 };
  }
}

function build(prefix: string): Tree {
  const shared = new Leaf(`${prefix}shared`, 7);
  const root = new Tree(`${prefix}root`, undefined, 0);
  for (let i = 0; i < 3; i++) {
    const child = new Tree(`${prefix}child${i}`, i % 2 === 0 ? shared : new Leaf(`own${i}`, i), i * 10);
    child.parent = root;
    child.tags.set("depth", 1);
    child.tags.set(`i${i}`, i);
    child.kinds.add(i % 2 === 0 ? "even" : "odd");
    root.children.push(child);
  }
  return root;
}

function summarize(t: Tree): string {
  let out = `${t.label}@${t.span.pos}-${t.span.end}`;
  if (t.leaf !== undefined) out += `(${t.leaf.name}:${t.leaf.weight})`;
  if (t.parent !== undefined) out += `^${t.parent.label}`;
  for (const [k, v] of t.tags) out += ` ${k}=${v}`;
  for (const k of t.kinds) out += ` #${k}`;
  for (const c of t.children) out += ` [${summarize(c)}]`;
  return out;
}

const lines: string[] = [];
function log(line: string): void {
  if (isMainThread) console.log(line);
  else lines.push(line);
}

function attempt(what: string, write: () => void): void {
  try {
    write();
    log(`${what} wrote`);
  } catch (e) {
    // A receiver's objects keep their class in scriptc and arrive as plain
    // clones in Node.js, so its messages name the class differently.
    const message = isMainThread ? (e as Error).message : (e as Error).message.replace(/#<\w+>/, "#<?>");
    log(`${what} ${(e as Error).name} ${message}`);
  }
}

function writes(side: string, root: Tree): void {
  const child = root.children[1]!;
  const base: Base = child;
  attempt(`${side} field`, () => {
    root.label = "changed";
  });
  attempt(`${side} increment`, () => {
    child.hits++;
  });
  attempt(`${side} base field`, () => {
    base.label = "changed";
  });
  attempt(`${side} leaf`, () => {
    child.leaf!.weight = 1;
  });
  attempt(`${side} record`, () => {
    child.span.pos = 5;
  });
  attempt(`${side} index`, () => {
    root.children[0] = child;
  });
  attempt(`${side} append`, () => {
    root.children[3] = child;
  });
  attempt(`${side} push`, () => {
    root.children.push(child);
  });
  attempt(`${side} pop`, () => {
    root.children.pop();
  });
  attempt(`${side} pop value`, () => {
    const last = root.children.pop();
    if (last !== undefined) log(`${side} popped ${last.label}`);
  });
  attempt(`${side} empty pop`, () => {
    child.children.pop();
  });
  attempt(`${side} shift`, () => {
    root.children.shift();
  });
  attempt(`${side} length`, () => {
    root.children.length = 0;
  });
  attempt(`${side} map set`, () => {
    child.tags.set("depth", 2);
  });
  attempt(`${side} map delete`, () => {
    child.tags.delete("depth");
  });
  attempt(`${side} set add`, () => {
    child.kinds.add("new");
  });
}

if (isMainThread) {
  console.log("published default", publishedDefault("main"));
  // Unpublished objects of the same classes stay writable.
  const scratch = build("s-");
  scratch.label = "scratch";
  scratch.children.push(new Tree("extra", undefined, 99));
  scratch.children[0]!.tags.set("depth", 5);
  scratch.children[0]!.hits++;
  console.log("scratch", summarize(scratch), scratch.children[0]!.hits);

  // A refused publish leaves the graph unchanged (and writable).
  const refused: unknown[] = [JSON.parse('{"a":1,"b":[2]}'), (): number => 1];
  attempt("publish function", () => {
    publish(refused);
  });
  const first = refused[0] as Record<string, unknown>;
  first.a = 2;
  refused.push(3);
  console.log("refused", JSON.stringify(refused[0]), refused.length);

  const root = publish(build(""));
  console.log("main", summarize(root));
  console.log("same", publish(root) === root);
  writes("main", root);

  const worker = new Worker(new URL(import.meta.url), { workerData: { root, label: "data" } });
  worker.on("message", (message: unknown) => {
    const reply = message as { lines: string[]; summary: string; mine: Tree };
    publish(reply.mine);
    for (const line of reply.lines) console.log(line);
    console.log("from worker", reply.summary);
    console.log("worker graph", summarize(reply.mine));
  });
  worker.on("exit", (code: number) => {
    console.log("exit", code);
  });
} else {
  log(`published default ${publishedDefault("worker")}`);
  const data = workerData as { root: Tree; label: string };
  const root = publish(data.root);
  // Node clones away the prototype; native readers resolve it in this worker.
  if (sharesPublishedGraphs) {
    const shared = untyped(root);
    if (shared.title() !== root.label || shared.constructor !== Tree)
      throw new Error("shared class prototype was not resolved in the receiving worker");
  }
  log(`worker ${data.label} ${summarize(root)}`);
  writes("worker", root);
  const mine = publish(build("w-"));
  parentPort!.postMessage({ lines, summary: summarize(root), mine });
}
