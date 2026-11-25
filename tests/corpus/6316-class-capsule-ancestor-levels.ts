// A 4-deep hierarchy. An instance enters a union through an arm that is its own class or an
// ancestor, becomes an untyped value, is tested with instanceof of every class and then used
// as that class.
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

class Tip extends Leaf {
  tip = 4;
  tipName(): string {
    return 'tip';
  }
}

type ViaRoot = Root | string | null;
type ViaMid = Mid | string | null;
type ViaLeaf = Leaf | string | null;
type ViaTip = Tip | string | null;

function viaRoot(level: number): ViaRoot {
  if (level === 0) return new Root();
  if (level === 1) return new Mid();
  if (level === 2) return new Leaf();
  if (level === 3) return new Tip();
  return level === 4 ? 'text' : null;
}

function viaMid(level: number): ViaMid {
  if (level === 1) return new Mid();
  if (level === 2) return new Leaf();
  if (level === 3) return new Tip();
  return level === 4 ? 'text' : null;
}

function viaLeaf(level: number): ViaLeaf {
  if (level === 2) return new Leaf();
  if (level === 3) return new Tip();
  return level === 4 ? 'text' : null;
}

function viaTip(level: number): ViaTip {
  if (level === 3) return new Tip();
  return level === 4 ? 'text' : null;
}

function asRoot(v: unknown): Root | null {
  return v instanceof Root ? v : null;
}

function asMid(v: unknown): Mid | null {
  return v instanceof Mid ? v : null;
}

function asLeaf(v: unknown): Leaf | null {
  return v instanceof Leaf ? v : null;
}

function asTip(v: unknown): Tip | null {
  return v instanceof Tip ? v : null;
}

function asMidOrUndefined(v: unknown): Mid | undefined {
  return v instanceof Mid ? v : undefined;
}

function tests(v: unknown): string {
  return (
    (v instanceof Root ? 'R' : '-') +
    (v instanceof Mid ? 'M' : '-') +
    (v instanceof Leaf ? 'L' : '-') +
    (v instanceof Tip ? 'T' : '-')
  );
}

// The nullable form: the narrowed value is converted to `C | null`.
function nullable(v: unknown): string {
  const r = asRoot(v);
  const m = asMid(v);
  const l = asLeaf(v);
  const t = asTip(v);
  const u = asMidOrUndefined(v);
  return [
    r === null ? 'null' : r.rootName(),
    m === null ? 'null' : m.midName() + '/' + m.mid,
    l === null ? 'null' : l.leafName() + '/' + l.mid,
    t === null ? 'null' : t.tipName() + '/' + t.tip,
    u === undefined ? 'undefined' : u.midName(),
  ].join(' ');
}

// The direct form: the narrowed value is used as the class in place.
function direct(v: unknown): string {
  const parts: string[] = [];
  if (v instanceof Root) parts.push(v.rootName());
  if (v instanceof Mid) parts.push(v.midName() + '/' + v.mid);
  if (v instanceof Leaf) parts.push(v.leafName() + '/' + v.mid);
  if (v instanceof Tip) parts.push(v.tipName() + '/' + v.tip);
  if (typeof v === 'string') parts.push('string ' + v);
  if (v === null) parts.push('null');
  return parts.join(' ');
}

function cell(label: string, run: () => string): void {
  try {
    console.log(label + ': ' + run());
  } catch (e) {
    console.log(label + ': THREW ' + (e instanceof Error ? e.message : String(e)));
  }
}

const names = ['Root', 'Mid', 'Leaf', 'Tip', 'string', 'null'];

for (let level = 0; level <= 5; level++) {
  const made = names[level]!;
  cell('root arm, ' + made + ', tests', () => tests(viaRoot(level)));
  cell('root arm, ' + made + ', nullable', () => nullable(viaRoot(level)));
  cell('root arm, ' + made + ', direct', () => direct(viaRoot(level)));
}
for (let level = 1; level <= 5; level++) {
  const made = names[level]!;
  cell('middle arm, ' + made + ', tests', () => tests(viaMid(level)));
  cell('middle arm, ' + made + ', nullable', () => nullable(viaMid(level)));
  cell('middle arm, ' + made + ', direct', () => direct(viaMid(level)));
}
for (let level = 2; level <= 5; level++) {
  const made = names[level]!;
  cell('leaf arm, ' + made + ', tests', () => tests(viaLeaf(level)));
  cell('leaf arm, ' + made + ', nullable', () => nullable(viaLeaf(level)));
  cell('leaf arm, ' + made + ', direct', () => direct(viaLeaf(level)));
}
for (let level = 3; level <= 5; level++) {
  const made = names[level]!;
  cell('tip arm, ' + made + ', tests', () => tests(viaTip(level)));
  cell('tip arm, ' + made + ', nullable', () => nullable(viaTip(level)));
  cell('tip arm, ' + made + ', direct', () => direct(viaTip(level)));
}
