// A class test on an untyped value: `instanceof`, a checked conversion into a
// class, and a member read through `any`, in a program that boxes many
// classes. The compiler lists the boxed classes' type keys in one table, a
// class and the classes below it side by side, so "is a C or below" is one
// range test and a generated class table switches on the value's slot. This
// program pins the answers: subclasses and siblings, classes of another
// module, a class whose key is longer than a 64-byte slot, a class with a
// name outside ASCII, error classes caught as untyped values, values that are
// no class instance at all, and every test that must fail. The conversions
// here all succeed, so Node and the native binary print the same.

import { Circle, Label, Poly, Quad, Round, Shape, Square, Tri, shapes } from './shapes.ts';

class K00 { n = 0; who(): string { return 'K00'; } }
class K01 { n = 1; who(): string { return 'K01'; } }
class K02 { n = 2; who(): string { return 'K02'; } }
class K03 { n = 3; who(): string { return 'K03'; } }
class K04 { n = 4; who(): string { return 'K04'; } }
class K05 extends K04 { m = 5; who(): string { return 'K05'; } }
class K06 { n = 6; who(): string { return 'K06'; } }
class K07 { n = 7; who(): string { return 'K07'; } }
class K08 { n = 8; who(): string { return 'K08'; } }
class K09 { n = 9; who(): string { return 'K09'; } }
class K10 { n = 10; who(): string { return 'K10'; } }
class K11 extends K10 { m = 11; who(): string { return 'K11'; } }
class K12 { n = 12; who(): string { return 'K12'; } }
class K13 { n = 13; who(): string { return 'K13'; } }
class K14 { n = 14; who(): string { return 'K14'; } }
class K15 { n = 15; who(): string { return 'K15'; } }
class K16 { n = 16; who(): string { return 'K16'; } }
class K17 extends K11 { p = 17; who(): string { return 'K17'; } }
class K18 { n = 18; who(): string { return 'K18'; } }
class K19 { n = 19; who(): string { return 'K19'; } }
class K20 { n = 20; who(): string { return 'K20'; } }
class K21 { n = 21; who(): string { return 'K21'; } }
class K22 { n = 22; who(): string { return 'K22'; } }
class K23 extends K10 { m = 23; who(): string { return 'K23'; } }
class K24 { n = 24; who(): string { return 'K24'; } }
class K25 { n = 25; who(): string { return 'K25'; } }
class K26 { n = 26; who(): string { return 'K26'; } }
class K27 { n = 27; who(): string { return 'K27'; } }
class K28 { n = 28; who(): string { return 'K28'; } }
class K29 { n = 29; who(): string { return 'K29'; } }
class K30 { n = 30; who(): string { return 'K30'; } }
class K31 { n = 31; who(): string { return 'K31'; } }

// Its type key holds more than 64 bytes: the table's slots widen for it.
class AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable {
  n = 64;
  who(): string {
    return 'long';
  }
}
class BelowTheLongName extends AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable {
  who(): string {
    return 'below long';
  }
}

// Its type key holds bytes outside ASCII.
class Überlänge {
  n = 65;
  who(): string {
    return 'umlaut';
  }
}

class AppError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
class DeepError extends AppError {
  constructor(message: string) {
    super(message, 7);
    this.name = 'DeepError';
  }
}

// Never instantiated and never boxed: every test for it fails.
class Never {
  n = -1;
}

type Rec = { name: string; n: number };

function caught(run: () => void): unknown {
  try {
    run();
  } catch (e) {
    return e;
  }
  return 'did not throw';
}

const rec: Rec = { name: 'rec', n: 100 };
const values: unknown[] = [
  ...shapes(),
  new Label('label'),
  new K00(), new K01(), new K02(), new K03(), new K04(), new K05(), new K06(), new K07(),
  new K08(), new K09(), new K10(), new K11(), new K12(), new K13(), new K14(), new K15(),
  new K16(), new K17(), new K18(), new K19(), new K20(), new K21(), new K22(), new K23(),
  new K24(), new K25(), new K26(), new K27(), new K28(), new K29(), new K30(), new K31(),
  new AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable(),
  new BelowTheLongName(),
  new Überlänge(),
  rec,
  JSON.parse('{"name":"parsed","n":101}'),
  caught(() => {
    throw new AppError('app', 3);
  }),
  caught(() => {
    throw new DeepError('deep');
  }),
  caught(() => {
    throw new RangeError('range');
  }),
  7,
  'text',
  true,
  null,
  undefined,
  [1, 2, 3],
  new Map<string, number>(),
];

function flag(x: boolean): string {
  return x ? 'T' : 'f';
}

/** Every class test, the ones that fail included. */
function matrix(v: unknown): string {
  return (
    flag(v instanceof Shape) + flag(v instanceof Round) + flag(v instanceof Circle) + flag(v instanceof Poly) +
    flag(v instanceof Quad) + flag(v instanceof Square) + flag(v instanceof Tri) + flag(v instanceof Label) +
    ' ' +
    flag(v instanceof K00) + flag(v instanceof K04) + flag(v instanceof K05) + flag(v instanceof K10) +
    flag(v instanceof K11) + flag(v instanceof K17) + flag(v instanceof K23) + flag(v instanceof K31) +
    ' ' +
    flag(v instanceof AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable) +
    flag(v instanceof BelowTheLongName) + flag(v instanceof Überlänge) + flag(v instanceof Never) +
    ' ' +
    flag(v instanceof AppError) + flag(v instanceof DeepError) + flag(v instanceof RangeError) + flag(v instanceof Error)
  );
}

/** The deepest class first, as a narrowing chain. */
function classify(v: unknown): string {
  if (v instanceof Square) return 'square ' + v.area();
  if (v instanceof Quad) return 'quad ' + v.area();
  if (v instanceof Tri) return 'tri ' + v.area();
  if (v instanceof Poly) return 'poly ' + v.sides;
  if (v instanceof Circle) return 'circle ' + v.area();
  if (v instanceof Round) return 'round ' + v.radius;
  if (v instanceof Shape) return 'shape ' + v.describe();
  if (v instanceof Label) return 'label ' + v.text;
  if (v instanceof K17) return 'k17 ' + v.p + ' ' + v.m + ' ' + v.n;
  if (v instanceof K11) return 'k11 ' + v.m;
  if (v instanceof K23) return 'k23 ' + v.m;
  if (v instanceof K10) return 'k10 ' + v.n;
  if (v instanceof K05) return 'k05 ' + v.m;
  if (v instanceof K04) return 'k04 ' + v.n;
  if (v instanceof BelowTheLongName) return 'below long ' + v.n;
  if (v instanceof AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable) return 'long ' + v.n;
  if (v instanceof Überlänge) return 'umlaut ' + v.n;
  if (v instanceof Never) return 'never';
  if (v instanceof DeepError) return 'deep error ' + v.code;
  if (v instanceof AppError) return 'app error ' + v.code;
  if (v instanceof Error) return 'error ' + v.name;
  return 'other';
}

const KEYS: string[] = ['name', 'n', 'm', 'sides', 'text', 'code', 'missing'];

function show(x: unknown): string {
  return typeof x === 'number' || typeof x === 'string' ? String(x) : typeof x;
}

/** Member reads through an untyped value: by name, by a computed key, a call. */
function reads(v: unknown): string {
  if (v === null || v === undefined) return 'nullish';
  const a = v as any;
  let out = show(a.n) + '/' + show(a.name);
  for (let i = 0; i < KEYS.length; i++) out += ' ' + show(a[KEYS[i]!]);
  out += ' ' + (typeof a.who === 'function' ? show(a.who()) : 'no who');
  out += ' ' + (typeof a.area === 'function' ? show(a.area()) : 'no area');
  return out;
}

for (let i = 0; i < values.length; i++) {
  const v = values[i];
  console.log(i + ': ' + matrix(v) + ' | ' + classify(v) + ' | ' + reads(v));
}

// Checked conversions that succeed: a class takes itself and every class below it.
function areaOf(shape: Shape): number {
  return shape.area();
}
function sidesOf(poly: Poly): number {
  return poly.sides;
}
function whoOf(k: K10): string {
  return k.who() + ' ' + k.n;
}
const untypedShapes: unknown[] = shapes();
let total = 0;
for (let i = 0; i < untypedShapes.length; i++) total += areaOf(untypedShapes[i] as Shape);
console.log('areas ' + total);
console.log('sides ' + sidesOf(untypedShapes[3] as Poly) + ' ' + sidesOf(untypedShapes[4] as Poly) + ' ' + sidesOf(untypedShapes[5] as Poly) + ' ' + sidesOf(untypedShapes[6] as Poly));
const tens: unknown[] = [new K10(), new K11(), new K17(), new K23()];
for (let i = 0; i < tens.length; i++) console.log('ten ' + whoOf(tens[i] as K10));
const long: unknown = new BelowTheLongName();
console.log((long as AClassWhoseNameIsLongerThanTheSixtyFourBytesOfOneSlotOfTheClassKeyTable).who());
const umlaut: unknown = new Überlänge();
console.log((umlaut as Überlänge).who());

// The same tests many times over values in rotation: every class is reached.
let hits = 0;
for (let round = 0; round < 200; round++) {
  const v = values[round % values.length];
  if (v instanceof Shape) hits += 1;
  if (v instanceof K10) hits += 10;
  if (v instanceof Never) hits += 100000;
  if (v instanceof Error) hits += 1000;
}
console.log('hits ' + hits);
