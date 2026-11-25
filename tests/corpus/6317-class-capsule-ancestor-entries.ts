// How the instance enters the union whose arm is an ancestor of its class: a return, a
// parameter, a class field, a record member, an optional member, an array element.
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

type Via = Root | string | null;

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
  let direct = '';
  if (v instanceof Leaf) direct = v.leafName() + '/' + v.mid;
  else if (v instanceof Mid) direct = v.midName() + '/' + v.mid;
  else if (v instanceof Root) direct = v.rootName();
  else direct = String(v);
  return tests + ' ' + (m === null ? 'null' : m.midName()) + ' ' + (l === null ? 'null' : l.leafName()) + ' ' + direct;
}

function cell(label: string, run: () => string): void {
  try {
    console.log(label + ': ' + run());
  } catch (e) {
    console.log(label + ': THREW ' + (e instanceof Error ? e.message : String(e)));
  }
}

function returned(level: number): Via {
  if (level === 0) return new Root();
  if (level === 1) return new Mid();
  if (level === 2) return new Leaf();
  return level === 3 ? 'text' : null;
}

function parameter(value: Via): unknown {
  return value;
}

class Holder {
  value: Via = null;
  readonly fixed: Via;
  constructor(fixed: Via) {
    this.fixed = fixed;
  }
}

interface Entry {
  child: Via;
  extra?: Via;
}

for (let level = 0; level <= 4; level++) {
  cell('return ' + level, () => show(returned(level)));
}

cell('parameter Root', () => show(parameter(new Root())));
cell('parameter Mid', () => show(parameter(new Mid())));
cell('parameter Leaf', () => show(parameter(new Leaf())));
cell('parameter string', () => show(parameter('text')));

const holder = new Holder(new Leaf());
cell('field readonly Leaf', () => show(holder.fixed));
holder.value = new Mid();
cell('field Mid', () => show(holder.value));
holder.value = new Leaf();
cell('field Leaf', () => show(holder.value));
holder.value = 'text';
cell('field string', () => show(holder.value));

const entry: Entry = { child: new Leaf() };
cell('member Leaf', () => show(entry.child));
cell('optional member absent', () => show(entry.extra));
entry.extra = new Mid();
cell('optional member Mid', () => show(entry.extra));
const untypedEntry: unknown = entry;
cell('record as untyped', () => {
  const record = untypedEntry as Entry;
  return show(record.child) + ' | ' + show(record.extra);
});

const items: Via[] = [new Root(), new Mid(), 'text', null, new Leaf()];
for (let i = 0; i < items.length; i++) {
  cell('element ' + i, () => show(items[i]));
}
const untypedItems: unknown = items;
cell('array as untyped', () => {
  if (!Array.isArray(untypedItems)) return 'not an array';
  const parts: string[] = [];
  for (const item of untypedItems) parts.push(show(item));
  return parts.join(' | ');
});
const pushed: unknown[] = [];
for (const item of items) pushed.push(item);
cell('untyped array elements', () => pushed.map((item) => show(item)).join(' | '));

const byName = new Map<string, Via>();
byName.set('leaf', new Leaf());
byName.set('mid', new Mid());
cell('map value Leaf', () => show(byName.get('leaf')));
cell('map value Mid', () => show(byName.get('mid')));
cell('map value absent', () => show(byName.get('none')));
