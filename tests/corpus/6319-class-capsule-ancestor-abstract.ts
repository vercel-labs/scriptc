// An abstract root as the arm, an interface the classes implement as the arm, and a 2-deep
// hierarchy whose root has a member.
abstract class Shape {
  abstract area(): number;
  describe(): string {
    return 'shape ' + this.area();
  }
}

class Square extends Shape {
  readonly side: number;
  constructor(side: number) {
    super();
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}

class Tile extends Square {
  label(): string {
    return 'tile ' + this.side;
  }
}

interface Named {
  name(): string;
}

class Plain implements Named {
  name(): string {
    return 'plain';
  }
}

class Fancy extends Plain {
  extra = 'fancy-field';
  name(): string {
    return 'fancy';
  }
}

class Base {
  id = 7;
}

class Derived extends Base {
  tag(): string {
    return 'derived ' + this.id;
  }
}

type ViaShape = Shape | string | null;
type ViaNamed = Named | string | null;
type ViaPlain = Plain | string | null;
type ViaBase = Base | number | undefined;

function shape(level: number): ViaShape {
  if (level === 0) return new Square(3);
  if (level === 1) return new Tile(4);
  return level === 2 ? 'text' : null;
}

function named(level: number): ViaNamed {
  if (level === 0) return new Plain();
  if (level === 1) return new Fancy();
  return level === 2 ? 'text' : null;
}

function plain(level: number): ViaPlain {
  if (level === 0) return new Plain();
  if (level === 1) return new Fancy();
  return level === 2 ? 'text' : null;
}

function base(level: number): ViaBase {
  if (level === 0) return new Base();
  if (level === 1) return new Derived();
  return level === 2 ? 5 : undefined;
}

function asSquare(v: unknown): Square | null {
  return v instanceof Square ? v : null;
}

function asTile(v: unknown): Tile | null {
  return v instanceof Tile ? v : null;
}

function asShape(v: unknown): Shape | null {
  return v instanceof Shape ? v : null;
}

function asPlain(v: unknown): Plain | null {
  return v instanceof Plain ? v : null;
}

function asFancy(v: unknown): Fancy | null {
  return v instanceof Fancy ? v : null;
}

function asDerived(v: unknown): Derived | undefined {
  return v instanceof Derived ? v : undefined;
}

function cell(label: string, run: () => string): void {
  try {
    console.log(label + ': ' + run());
  } catch (e) {
    console.log(label + ': THREW ' + (e instanceof Error ? e.message : String(e)));
  }
}

for (let level = 0; level <= 3; level++) {
  cell('abstract root ' + level, () => {
    const v: unknown = shape(level);
    const s = asShape(v);
    const q = asSquare(v);
    const t = asTile(v);
    return [
      v instanceof Shape ? 'S' : '-',
      v instanceof Square ? 'Q' : '-',
      v instanceof Tile ? 'T' : '-',
      s === null ? 'null' : s.describe(),
      q === null ? 'null' : 'side ' + q.side + ' area ' + q.area(),
      t === null ? 'null' : t.label(),
    ].join(' ');
  });
  cell('abstract root direct ' + level, () => {
    const v: unknown = shape(level);
    if (v instanceof Tile) return v.label() + ' ' + v.describe();
    if (v instanceof Square) return 'square ' + v.side;
    return String(v);
  });
  cell('interface arm ' + level, () => {
    const v: unknown = named(level);
    const p = asPlain(v);
    const f = asFancy(v);
    return [
      v instanceof Plain ? 'P' : '-',
      v instanceof Fancy ? 'F' : '-',
      p === null ? 'null' : p.name(),
      f === null ? 'null' : f.name() + '/' + f.extra,
    ].join(' ');
  });
  cell('implementing class arm ' + level, () => {
    const v: unknown = plain(level);
    const p = asPlain(v);
    const f = asFancy(v);
    return [
      v instanceof Plain ? 'P' : '-',
      v instanceof Fancy ? 'F' : '-',
      p === null ? 'null' : p.name(),
      f === null ? 'null' : f.name() + '/' + f.extra,
    ].join(' ');
  });
  cell('root with a member ' + level, () => {
    const v: unknown = base(level);
    const d = asDerived(v);
    return (v instanceof Base ? 'B' : '-') + (v instanceof Derived ? 'D' : '-') + ' ' + (d === undefined ? 'undefined' : d.tag());
  });
}
