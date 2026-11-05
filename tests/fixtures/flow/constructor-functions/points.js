// @flow
// Constructor functions whose instances a record type describes. A plain
// one builds the record; one whose prototype the program uses, or whose
// body returns or reads `arguments`, keeps the object it constructs.

type Point = {x: number, y: number};
type Tagged = {tag: string, size: number};

function PlainPoint(this: $FlowFixMe, x: number, y: number) {
  const sum = x + y;
  this.x = x;
  this.y = sum - x;
}

function MethodPoint(this: $FlowFixMe, x: number, y: number) {
  this.x = x;
  this.y = y;
}
MethodPoint.prototype.sum = function (): number {
  return this.x + this.y;
};

function EarlyPoint(this: $FlowFixMe, x: number, y: number) {
  this.x = x;
  this.y = y;
  if (x < 0) return;
}

function CountingTag(this: $FlowFixMe, tag: string) {
  this.tag = tag;
  this.size = arguments.length;
}

export function plain(): Point {
  const p: Point = new (PlainPoint: any)(1, 2);
  return p;
}

export function withMethod(): number {
  const p = new (MethodPoint: any)(3, 4);
  return p.sum();
}

export function early(): Point {
  const p: Point = new (EarlyPoint: any)(-1, 5);
  return p;
}

export function counting(): Tagged {
  const t: Tagged = new (CountingTag: any)('a', 'extra');
  return t;
}

type MaybeSized = {x: number, size?: number};

// Leaves the optional field out: still a record, without `size`.
function OptionalPoint(this: $FlowFixMe, x: number) {
  this.x = x;
}

// Reads `this` after writing it.
function ReadingPoint(this: $FlowFixMe, x: number) {
  this.x = x;
  this.y = this.x + 1;
}

// Writes a field the record does not have.
function ExtraPoint(this: $FlowFixMe, x: number, y: number) {
  this.x = x;
  this.y = y;
  this.z = x + y;
}

// Exported under another name (alias.js extends it through that name).
function AliasedPoint(this: $FlowFixMe, x: number, y: number) {
  this.x = x;
  this.y = y;
}
export {AliasedPoint as BasePoint};

// Assigns its fields in another order than the type lists them: the record
// keeps the order the body creates its keys in.
function SwappedPoint(this: $FlowFixMe, x: number, y: number) {
  this.y = y;
  this.x = x;
}

// Reads a local a later statement declares, through a closure.
function LaterPoint(this: $FlowFixMe, x: number) {
  const double = (): number => base;
  const base = x * 2;
  this.x = double();
  this.y = base + 1;
}

export function ordered(): Array<Point> {
  const swapped: Point = new (SwappedPoint: any)(1, 2);
  const later: Point = new (LaterPoint: any)(2);
  return [swapped, later];
}

export function optional(): MaybeSized {
  const p: MaybeSized = new (OptionalPoint: any)(7);
  return p;
}

export function others(): Array<Point> {
  const reading: Point = new (ReadingPoint: any)(1, 0);
  const extra: Point = new (ExtraPoint: any)(2, 3);
  const aliased: Point = new (AliasedPoint: any)(4, 5);
  return [reading, extra, aliased];
}
