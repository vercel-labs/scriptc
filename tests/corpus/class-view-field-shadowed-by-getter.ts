// An own data property that shadows a getter of the same name stays the
// value the conversion copies: the view answers accessor-backed members
// through their getters only for members it does not already hold.

interface Kind {
  readonly kind: number;
  readonly text: string;
}

class Tagged {
  private flags: number;
  readonly text: string;
  constructor(flags: number, text: string) {
    this.flags = flags;
    this.text = text;
  }
  get kind(): number {
    return this.flags & 0x1ff;
  }
}

function describe(value: unknown): string {
  const tagged = value as Kind;
  return `${tagged.kind} ${tagged.text}`;
}

const shadowed = new Tagged(3, "a");
Object.defineProperty(shadowed, "kind", {
  value: 42,
  enumerable: true,
  writable: true,
  configurable: true,
});
console.log(describe(shadowed as unknown));

const plain = new Tagged(3, "b");
console.log(describe(plain as unknown));
