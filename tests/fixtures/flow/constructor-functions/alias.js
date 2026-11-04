// @flow
import {BasePoint} from './points.js';

BasePoint.prototype.norm = function (): number {
  return Math.abs(this.x) + Math.abs(this.y);
};

export function viaAlias(): number {
  const p = new (BasePoint: any)(-3, 4);
  return p.norm();
}
