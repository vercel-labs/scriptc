// Class-union arms that are hierarchies: an instance of a subclass is in
// its base's arm, sibling subclasses can be arms of one union, virtual
// methods dispatch through a narrowed arm, and thrown instances keep their
// class through a catch.
abstract class Node {
  readonly pos: number;
  constructor(pos: number) {
    this.pos = pos;
  }
  abstract text(): string;
}

class Identifier extends Node {
  readonly name: string;
  constructor(pos: number, name: string) {
    super(pos);
    this.name = name;
  }
  text(): string {
    return this.name;
  }
}

class PrivateIdentifier extends Node {
  readonly name: string;
  constructor(pos: number, name: string) {
    super(pos);
    this.name = name;
  }
  text(): string {
    return `#${this.name}`;
  }
}

class Literal extends Node {
  readonly value: number;
  constructor(pos: number, value: number) {
    super(pos);
    this.value = value;
  }
  text(): string {
    return String(this.value);
  }
}

class BigLiteral extends Literal {
  text(): string {
    return `${this.value}n`;
  }
}

class Symbol_ {
  readonly name: string;
  uses = 0;
  constructor(name: string) {
    this.name = name;
  }
}

class Signature {
  readonly params: number;
  constructor(params: number) {
    this.params = params;
  }
}

class Type {
  readonly id: number;
  constructor(id: number) {
    this.id = id;
  }
}

class ObjectType extends Type {
  readonly members: string[] = [];
}

class UnionType extends Type {
  readonly types: Type[];
  constructor(id: number, types: Type[]) {
    super(id);
    this.types = types;
  }
}

// Sibling subclasses as arms.
type MemberName = Identifier | PrivateIdentifier;
function memberText(name: MemberName): string {
  return name instanceof PrivateIdentifier ? `private ${name.name}` : `public ${name.name}`;
}
const names: MemberName[] = [new Identifier(0, "a"), new PrivateIdentifier(1, "b"), new Identifier(2, "c")];
console.log(names.map(memberText).join(", "), names.map((n) => n.text()).join(" "), names.map((n) => n.pos).join(""));

// Whole hierarchies as arms, and a subclass instance in its base's arm.
type Target = Symbol_ | Type | Signature | Node;
function describe(target: Target): string {
  if (target instanceof Symbol_) return `symbol ${target.name}`;
  if (target instanceof Signature) return `signature/${target.params}`;
  if (target instanceof UnionType) return `union ${target.id} of ${target.types.length}`;
  if (target instanceof Type) return `${target instanceof ObjectType ? "object" : "type"} ${target.id}`;
  return `node ${target.text()} at ${target.pos}`;
}
const targets: Target[] = [];
const sym = new Symbol_("x");
const obj = new ObjectType(2);
targets.push(sym, new Type(1), obj, new UnionType(3, [obj, new Type(4)]), new Signature(2));
targets.push(new Identifier(5, "y"), new Literal(6, 42), new BigLiteral(7, 9), names[1]!);
console.log(targets.map(describe).join("; "));

// A resolution stack keyed by target identity, as a checker keeps one.
const stack: Target[] = [];
const props: number[] = [];
function push(target: Target, prop: number): boolean {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === target && props[i] === prop) return false;
  stack.push(target);
  props.push(prop);
  return true;
}
function pop(): void {
  stack.pop();
  props.pop();
}
let cycles = 0;
for (let round = 0; round < 200; round++) {
  const t = targets[round % targets.length]!;
  if (!push(t, round % 3)) cycles++;
  if (!push(sym, 0)) cycles++;
  if (round % 4 === 3) {
    pop();
    pop();
  }
}
console.log(stack.length, cycles, describe(stack[stack.length - 1]!));

// Checked casts out of the union.
function symbolName(t: Target): string {
  return (t as Symbol_).name;
}
function typeId(t: Target): number {
  return (t as Type).id;
}
console.log(symbolName(sym), typeId(obj), typeId(targets[3]!));

// Unit arms beside hierarchy arms.
type OptionalTarget = Type | Node | undefined;
const optional: OptionalTarget[] = [undefined, new Literal(1, 1), new UnionType(5, []), undefined];
console.log(optional.map((t) => (t === undefined ? "-" : t instanceof Node ? t.text() : `t${t.id}`)).join(" "));

// Throwing and catching union arms.
function fail(target: Target): never {
  throw target;
}
for (const t of [sym, new Signature(0), new Literal(3, 3)] as Target[]) {
  try {
    fail(t);
  } catch (e) {
    if (e instanceof Symbol_) console.log("caught symbol", e.name);
    else if (e instanceof Signature) console.log("caught signature", e.params);
    else if (e instanceof Node) console.log("caught node", e.text());
  }
}
