// Conversions whose target holds the subclass inside another type: an array of the subclass,
// a record with a subclass member, a union of two subclasses, converted from a value whose
// instances entered through the root arm.
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

class Side extends Root {
  sideName(): string {
    return 'side';
  }
}

type Via = Root | string | null;

interface Pair {
  first: Mid;
  second: Leaf | null;
}

function made(level: number): Via {
  if (level === 0) return new Root();
  if (level === 1) return new Mid();
  if (level === 2) return new Leaf();
  if (level === 3) return new Side();
  return level === 4 ? 'text' : null;
}

function isMidArray(v: unknown): v is Mid[] {
  return Array.isArray(v) && v.every((item) => item instanceof Mid);
}

function midOrSide(v: unknown): Mid | Side | null {
  if (v instanceof Mid) return v;
  if (v instanceof Side) return v;
  return null;
}

function cell(label: string, run: () => string): void {
  try {
    console.log(label + ': ' + run());
  } catch (e) {
    console.log(label + ': THREW ' + (e instanceof Error ? e.message : String(e)));
  }
}

cell('array of the subclass', () => {
  const values: unknown[] = [made(1), made(2)];
  const untyped: unknown = values;
  if (!isMidArray(untyped)) return 'not all Mid';
  return untyped.map((item) => item.midName() + '/' + item.mid).join(' ');
});

cell('array of the union as the subclass', () => {
  const values: Via[] = [made(2), made(1)];
  const untyped: unknown = values;
  if (!isMidArray(untyped)) return 'not all Mid';
  return untyped.map((item) => item.midName() + '/' + item.mid).join(' ');
});

cell('record with subclass members', () => {
  const record: unknown = { first: made(1), second: made(2) };
  const pair = record as Pair;
  return pair.first.midName() + ' ' + (pair.second === null ? 'null' : pair.second.leafName());
});

cell('record with a null member', () => {
  const record: unknown = { first: made(2), second: made(5) };
  const pair = record as Pair;
  return pair.first.midName() + ' ' + (pair.second === null ? 'null' : pair.second.leafName());
});

for (let level = 0; level <= 5; level++) {
  cell('two subclass arms ' + level, () => {
    const either = midOrSide(made(level));
    if (either === null) return 'null';
    return either instanceof Side ? either.sideName() : either.midName() + '/' + either.mid;
  });
  cell('assertion to the nullable subclass ' + level, () => {
    const v: unknown = made(level);
    if (!(v instanceof Mid) && v !== null) return 'neither';
    const mid = v as Mid | null;
    return mid === null ? 'null' : mid.midName();
  });
  cell('optional chain on the narrowed value ' + level, () => {
    const v: unknown = made(level);
    const leaf: Leaf | undefined = v instanceof Leaf ? v : undefined;
    return leaf?.leafName() ?? 'none';
  });
}
