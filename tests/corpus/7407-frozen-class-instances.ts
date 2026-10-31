// Object.freeze, Object.seal and Object.preventExtensions of class instances
// held in untyped values. The operation changes the instance itself: writes
// through its typed references, through untyped references and through its
// methods then throw Node's TypeError (this module is strict mode code), and
// Object.isFrozen, isSealed and isExtensible report the state through either
// reference.
export {};

function report(e: unknown): void {
  console.log((e as Error).name + ": " + (e as Error).message);
}

function freezeUnknown(value: unknown): unknown {
  return Object.freeze(value);
}

function sealUnknown(value: unknown): unknown {
  return Object.seal(value);
}

function preventUnknown(value: unknown): unknown {
  return Object.preventExtensions(value);
}

function integrity(value: unknown): string {
  return [Object.isFrozen(value), Object.isSealed(value), Object.isExtensible(value)].join(" ");
}

function writeAny(value: any, key: string, next: unknown): void {
  value[key] = next;
}

function deleteAny(value: any, key: string): void {
  delete value[key];
}

class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  move(dx: number): void {
    this.x += dx;
  }
}

class Labeled extends Point {
  label: string;
  constructor(x: number, y: number, label: string) {
    super(x, y);
    this.label = label;
  }
  rename(label: string): void {
    this.label = label;
  }
}

class Counter {
  count = 0;
  tags: string[] = [];
  bump(): number {
    return ++this.count;
  }
}

function frozen(): void {
  const p = new Point(1, 2);
  console.log(integrity(p));
  const same = freezeUnknown(p);
  console.log(same === p, integrity(p), Object.isFrozen(p));
  try { p.x = 5; } catch (e) { report(e); }
  try { p.move(1); } catch (e) { report(e); }
  try { writeAny(p, "y", 9); } catch (e) { report(e); }
  try { writeAny(p, "z", 1); } catch (e) { report(e); }
  console.log(p.x, p.y, JSON.stringify(p));

  const l = new Labeled(3, 4, "a");
  const base: Point = l;
  freezeUnknown(base);
  console.log(integrity(l), integrity(base));
  try { l.rename("b"); } catch (e) { report(e); }
  try { base.x = 0; } catch (e) { report(e); }
  try { writeAny(l, "label", "c"); } catch (e) { report(e); }
  console.log(l.x, l.label, l instanceof Labeled);
  freezeUnknown(l);
  console.log(integrity(l));
}

function sealed(): void {
  const c = new Counter();
  sealUnknown(c);
  console.log(integrity(c));
  console.log(c.bump(), c.bump());
  c.tags.push("kept");
  try { writeAny(c, "extra", 1); } catch (e) { report(e); }
  writeAny(c, "count", 10);
  console.log(c.count, c.tags.join(), JSON.stringify(c));
  freezeUnknown(c);
  console.log(integrity(c));
  try { c.bump(); } catch (e) { report(e); }
  c.tags.push("still");
  console.log(c.count, c.tags.join());
}

function notExtensible(): void {
  const l = new Labeled(0, 0, "n");
  preventUnknown(l);
  console.log(integrity(l));
  l.move(2);
  l.rename("m");
  try { writeAny(l, "extra", true); } catch (e) { report(e); }
  console.log(l.x, l.label, Object.keys(l).join());
  sealUnknown(l);
  console.log(integrity(l));
  writeAny(l, "y", 7);
  console.log(l.y);
}

function untouched(): void {
  const p = new Point(5, 6);
  const q = new Point(7, 8);
  freezeUnknown(q);
  p.x = 50;
  writeAny(p, "y", 60);
  console.log(p.x, p.y, integrity(p), integrity(q));
}

function added(): void {
  const p = new Point(1, 1);
  writeAny(p, "extra", 1);
  freezeUnknown(p);
  console.log(integrity(p), Object.keys(p).join());
  try { deleteAny(p, "extra"); } catch (e) { report(e); }
  console.log((p as any).extra, JSON.stringify(p));
}

const tag = Symbol("tag");

class Tagged {
  [tag] = 1;
  name = "n";
  bump(): void {
    this[tag] += 1;
  }
}

class Subtagged extends Tagged {
  extra = 0;
}

function symbols(): void {
  const t = new Tagged();
  freezeUnknown(t);
  console.log(integrity(t), Object.getOwnPropertyDescriptor(t, tag)?.writable);
  try { t[tag] = 5; } catch (e) { report(e); }
  try { t.bump(); } catch (e) { report(e); }
  console.log(t[tag]);

  const s = new Subtagged();
  sealUnknown(s);
  s[tag] = 3;
  console.log(integrity(s), s[tag], Object.getOwnPropertyDescriptor(s, tag)?.configurable);
  freezeUnknown(s);
  try { s[tag] = 4; } catch (e) { report(e); }
  console.log(integrity(s), s[tag]);

  const u = new Tagged();
  Object.freeze(u);
  console.log(integrity(u));
  try { u[tag] = 9; } catch (e) { report(e); }
  console.log(u[tag]);
}

frozen();
sealed();
notExtensible();
untouched();
added();
symbols();
