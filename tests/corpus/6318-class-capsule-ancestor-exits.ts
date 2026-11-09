// How the union value leaves: as an untyped value, through a wider union, through a generic,
// and narrowed in place while still typed as the union.
class Root {
  rootName(): string {
    return 'root';
  }
}

class Mid extends Root {
  mid = 'mid-field';
  midName(): string {
    return 'mid';
  }
}

class Leaf extends Mid {
  leafName(): string {
    return 'leaf';
  }
}

class Other {
  otherName(): string {
    return 'other';
  }
}

type Via = Root | string | null;
type Wider = Via | Other | number | boolean | undefined;

function made(level: number): Via {
  if (level === 0) return new Root();
  if (level === 1) return new Mid();
  if (level === 2) return new Leaf();
  return level === 3 ? 'text' : null;
}

function asMid(v: unknown): Mid | null {
  return v instanceof Mid ? v : null;
}

function asLeaf(v: unknown): Leaf | null {
  return v instanceof Leaf ? v : null;
}

function show(v: unknown): string {
  const tests = (v instanceof Root ? 'R' : '-') + (v instanceof Mid ? 'M' : '-') + (v instanceof Leaf ? 'L' : '-');
  const m = asMid(v);
  const l = asLeaf(v);
  return tests + ' ' + (m === null ? 'null' : m.midName() + '/' + m.mid) + ' ' + (l === null ? 'null' : l.leafName());
}

function typed(v: Via): string {
  if (v instanceof Leaf) return 'leaf ' + v.leafName() + '/' + v.mid;
  if (v instanceof Mid) return 'mid ' + v.midName() + '/' + v.mid;
  if (v instanceof Root) return 'root ' + v.rootName();
  return v === null ? 'null' : 'string ' + v;
}

function widen(v: Via): Wider {
  return v;
}

function wide(v: Wider): string {
  if (v instanceof Leaf) return 'leaf ' + v.leafName() + '/' + v.mid;
  if (v instanceof Mid) return 'mid ' + v.midName() + '/' + v.mid;
  if (v instanceof Root) return 'root ' + v.rootName();
  if (v instanceof Other) return 'other ' + v.otherName();
  return String(v);
}

function leafOfWide(v: Wider): Leaf | null {
  return v instanceof Leaf ? v : null;
}

function midOrOther(v: unknown): Mid | Other | null {
  return v instanceof Mid ? v : v instanceof Other ? v : null;
}

function identity<T>(value: T): T {
  return value;
}

function showGeneric<T>(value: T): string {
  return show(value);
}

function firstOf<T>(values: T[]): T {
  return values[0]!;
}

class Box<T> {
  readonly held: T;
  constructor(held: T) {
    this.held = held;
  }
  get(): T {
    return this.held;
  }
}

function cell(label: string, run: () => string): void {
  try {
    console.log(label + ': ' + run());
  } catch (e) {
    console.log(label + ': THREW ' + (e instanceof Error ? e.message : String(e)));
  }
}

for (let level = 0; level <= 4; level++) {
  cell('untyped ' + level, () => show(made(level)));
  cell('typed ' + level, () => typed(made(level)));
  cell('wider typed ' + level, () => wide(widen(made(level))));
  cell('wider leaf ' + level, () => {
    const leaf = leafOfWide(widen(made(level)));
    return leaf === null ? 'null' : leaf.leafName();
  });
  cell('wider untyped ' + level, () => show(widen(made(level))));
  cell('two class arms ' + level, () => {
    const either = midOrOther(made(level));
    if (either === null) return 'null';
    return either instanceof Other ? either.otherName() : either.midName() + '/' + either.mid;
  });
  cell('generic identity ' + level, () => show(identity(made(level))));
  cell('generic untyped ' + level, () => showGeneric(made(level)));
  cell('generic identity of untyped ' + level, () => show(identity<unknown>(made(level))));
  cell('generic array ' + level, () => show(firstOf([made(level)])));
  cell('generic box ' + level, () => show(new Box<Via>(made(level)).get()));
  cell('generic box untyped ' + level, () => show(new Box<unknown>(made(level)).held));
}

cell('other through wider', () => {
  const wider: Wider = new Other();
  const either = midOrOther(wider);
  return either === null ? 'null' : either instanceof Other ? either.otherName() : either.midName();
});
