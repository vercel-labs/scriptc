// Per-file regions next to a large live heap: a checker-like graph of ordinary objects with
// parent links (cycle-collector candidates that stay alive) and, for each file, an emit that
// builds ProgramLifetime nodes and ordinary objects they own (some cyclic) in a region that is
// released right after.
//
//   emit <checker-types> <files> <nodes-per-file> [plain]
//
// `plain` never constructs a region.
import type { ProgramLifetime } from "@scriptc/types";
import { LifetimeRegion } from "@scriptc/experimental";

class Type {
  readonly id: number;
  parent: Type | undefined;
  readonly members: Type[] = [];
  constructor(id: number, parent: Type | undefined) {
    this.id = id;
    this.parent = parent;
    parent?.members.push(this);
  }
}

class Scope {
  readonly parent: Scope | undefined;
  readonly children: Scope[] = [];
  readonly names = new Map<string, OutNode>();
  constructor(parent: Scope | undefined) {
    this.parent = parent;
    parent?.children.push(this);
  }
}

class OutNode implements ProgramLifetime {
  readonly kind: number;
  readonly kids: OutNode[] = [];
  scope: Scope | undefined = undefined;
  text: string;
  constructor(kind: number, text: string) {
    this.kind = kind;
    this.text = text;
  }
}

const typeCount = Number(process.argv[2] ?? "400000");
const files = Number(process.argv[3] ?? "200");
const nodesPerFile = Number(process.argv[4] ?? "2000");
const plain = process.argv[5] === "plain";

// The checker: one tree of types, each holding its parent and its members, so a walk
// from any of them reaches all of them.
const roots: Type[] = [];
let id = 0;
let level: Type[] = [new Type(id++, undefined)];
while (id < typeCount) {
  const next: Type[] = [];
  for (const t of level) for (let k = 0; k < 4 && id < typeCount; k++) next.push(new Type(id++, t));
  for (const t of next) roots.push(t);
  level = next;
}

function lookUp(t: Type): number {
  let depth = 0;
  for (let p: Type | undefined = t; p !== undefined; p = p.parent) depth++;
  return depth;
}

function emit(file: number): number {
  const top = new Scope(undefined);
  const root = new OutNode(0, `file${file}`);
  let scope = top;
  let sum = 0;
  const seen: Type[] = [];
  for (let i = 0; i < nodesPerFile; i++) {
    const node = new OutNode(i % 7, `n${i}`);
    root.kids.push(node);
    if (i % 50 === 0) scope = new Scope(scope);
    node.scope = scope;
    scope.names.set(node.text, node);
    // Reads of the checker: temporaries that leave its types buffered.
    const t = roots[(file * 31 + i) % roots.length]!.members[i % 4];
    if (t !== undefined) {
      sum += lookUp(t);
      seen.push(t);
    }
  }
  return sum + root.kids.length + seen.length;
}

const t0 = performance.now();
let total = 0;
for (let f = 0; f < files; f++) {
  if (plain) {
    total += emit(f);
    continue;
  }
  const region = new LifetimeRegion();
  total += region.run(() => emit(f));
  region.release();
}
const ms = performance.now() - t0;
console.log(`emitted ${files} files, checksum ${total}`);
console.log(`emit ${ms.toFixed(1)} ms per-file ${(ms / files).toFixed(2)} ms`);
