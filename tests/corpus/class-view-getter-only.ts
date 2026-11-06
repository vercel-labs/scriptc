// A field that exists only behind a getter: the checked view of a class
// instance holds the instance's own data fields and answers its
// accessor-backed members through their getters, so a conversion to the
// interface copies the value the getter answers rather than undefined.

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

console.log(describe(new Tagged(10, "a") as unknown));
console.log(describe(new Tagged(0x2ff, "b") as unknown));
