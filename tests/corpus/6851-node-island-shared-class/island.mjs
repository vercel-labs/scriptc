import { Point, isPoint, make, remember, remembered } from "./shapes.mjs";

export function check(p) {
  return `${p instanceof Point} ${isPoint(p)} ${p.describe()} norm=${p.norm()}`;
}

export function create(x, y) {
  return new Point(x, y);
}

export function selfCheck() {
  const p = new Point(1, 1);
  return `${p instanceof Point} ${isPoint(p)} ${make(2, 2) instanceof Point}`;
}

export function plainIsPoint() {
  return `${{ x: 1 } instanceof Point} ${isPoint({ x: 1 })}`;
}

export function keep(p) {
  return remember(p);
}

export function firstIsNative(p) {
  return remembered(0) === p;
}

export function viaFactory() {
  const p = make(5, 12);
  return `${p.describe()} ${p.norm()} ${p instanceof Point}`;
}

export function sameClass(c) {
  return c === Point;
}
