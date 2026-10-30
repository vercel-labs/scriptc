import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";
import type { ProgramLifetime } from "@scriptc/types";

// Class unions over ProgramLifetime classes, whose instances keep their
// class id in a 32-bit header and count no references: a checker's
// resolution stack of `Symbol | Type | Signature | Node` targets, union
// fields, and a published graph read by a worker. Receivers read only
// fields, since Node.js clones what it posts.

abstract class Node implements ProgramLifetime {
  readonly kind: string;
  readonly pos: number;
  parent: Node | undefined = undefined;
  constructor(kind: string, pos: number) {
    this.kind = kind;
    this.pos = pos;
  }
}

class Identifier extends Node {
  readonly text: string;
  constructor(pos: number, text: string) {
    super("identifier", pos);
    this.text = text;
  }
}

class PrivateIdentifier extends Node {
  readonly text: string;
  constructor(pos: number, text: string) {
    super("private", pos);
    this.text = text;
  }
}

class Call extends Node {
  readonly callee: Identifier | PrivateIdentifier;
  constructor(pos: number, callee: Identifier | PrivateIdentifier) {
    super("call", pos);
    this.callee = callee;
    callee.parent = this;
  }
}

class Sym implements ProgramLifetime {
  readonly kind = "symbol";
  readonly name: string;
  declaration: Node | Sym | undefined = undefined;
  constructor(name: string) {
    this.name = name;
  }
}

class Type implements ProgramLifetime {
  readonly kind: string = "type";
  readonly id: number;
  origin: Sym | Type | undefined = undefined;
  constructor(id: number) {
    this.id = id;
  }
}

class ObjectType extends Type {
  readonly kind: string = "object";
}

class Signature implements ProgramLifetime {
  readonly kind = "signature";
  readonly arity: number;
  constructor(arity: number) {
    this.arity = arity;
  }
}

type Target = Sym | Type | Signature | Node;

function label(t: Target | undefined): string {
  if (t === undefined) return "-";
  switch (t.kind) {
    case "symbol":
      return `S:${(t as Sym).name}`;
    case "type":
    case "object":
      return `T${(t as Type).id}`;
    case "signature":
      return `sig${(t as Signature).arity}`;
    default:
      return `N@${(t as Node).pos}`;
  }
}

class Checker {
  readonly targets: Target[] = [];
  readonly props: number[] = [];
  depth = 0;
  cycles = 0;
  push(target: Target, prop: number): boolean {
    for (let i = this.depth - 1; i >= 0; i--)
      if (this.targets[i] === target && this.props[i] === prop) {
        this.cycles++;
        return false;
      }
    if (this.depth < this.targets.length) {
      this.targets[this.depth] = target;
      this.props[this.depth] = prop;
    } else {
      this.targets.push(target);
      this.props.push(prop);
    }
    this.depth++;
    return true;
  }
  pop(): void {
    this.depth--;
  }
}

function program(prefix: string): Target[] {
  const out: Target[] = [];
  for (let i = 0; i < 4; i++) {
    const sym = new Sym(`${prefix}${i}`);
    const id = new Identifier(i * 10, `${prefix}${i}`);
    const call = new Call(i * 10 + 1, i % 2 === 0 ? id : new PrivateIdentifier(i * 10 + 2, `${prefix}p${i}`));
    sym.declaration = i % 3 === 0 ? call : sym;
    const type = i % 2 === 0 ? new Type(i) : new ObjectType(i);
    type.origin = i === 0 ? sym : type;
    out.push(sym, type, new Signature(i), call, call.callee);
  }
  return out;
}

function local(): void {
  const targets = program("a");
  const checker = new Checker();
  for (let round = 0; round < 400; round++) {
    const t = targets[(round * 7) % targets.length]!;
    if (checker.push(t, round % 2)) {
      if (round % 5 === 4) checker.pop();
    }
    if (checker.depth > 12) checker.depth = 2;
  }
  console.log(checker.depth, checker.cycles, checker.targets.slice(0, 6).map(label).join(" "));
  console.log(targets.map(label).join(" "));
  console.log(
    targets
      .filter((t) => t instanceof Sym)
      .map((t) => label((t as Sym).declaration))
      .join(" "),
    targets.filter((t) => t instanceof Type).map((t) => label((t as Type).origin)).join(" "),
  );
  const member: (Identifier | PrivateIdentifier)[] = [];
  for (const t of targets) {
    if (t instanceof Identifier) member.push(t);
    else if (t instanceof PrivateIdentifier) member.push(t);
  }
  console.log(member.map((m) => (m instanceof PrivateIdentifier ? `#${m.text}` : m.text)).join(" "));
}

if (isMainThread) {
  local();
  const shared = publish(program("w"));
  console.log("published", shared.map(label).join(" "));
  const worker = new Worker(new URL(import.meta.url), { workerData: { shared } });
  worker.on("message", (message: unknown) => {
    console.log("worker", message as string);
  });
} else {
  const { shared } = workerData as { shared: Target[] };
  const kinds = shared.map((t) => t.kind).join(",");
  const names = shared.map((t) => (t.kind === "symbol" ? (t as Sym).name : "")).join("");
  parentPort!.postMessage(`${shared.length} ${kinds} ${names}`);
}
