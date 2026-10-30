export class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  norm() {
    return Math.hypot(this.x, this.y);
  }
  describe() {
    return `(${this.x},${this.y})`;
  }
}

const kept = [];

export function remember(p) {
  kept.push(p);
  return kept.length;
}

export function remembered(i) {
  return kept[i];
}

export function describeAll() {
  return kept.map((p) => p.describe()).join(" ");
}

export function make(x, y) {
  return new Point(x, y);
}

export function isPoint(p) {
  return p instanceof Point;
}
