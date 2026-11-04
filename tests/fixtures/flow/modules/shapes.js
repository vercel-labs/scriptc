/**
 * @flow
 */

import type {Point, Named} from './types.js';
import {type Id, makeId} from './types.js';

export type Labeled = {...Named, point: Point};
type Readonly = $ReadOnly<{count: number}>;
type Keys = $Keys<{small: 1, large: 2}>;
export function nextId(n: number): Id {
  return makeId('user', n);
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function describe(item: Labeled, note: ?string): string {
  const suffix = note == null ? '' : ' (' + note + ')';
  return item.name + ' at ' + item.point.x + ',' + item.point.y + suffix;
}

export function total(counts: Array<Readonly>): number {
  let sum = 0;
  for (const c of counts) sum += c.count;
  return sum;
}

export function size(key: Keys): number {
  return key === 'small' ? 1 : 2;
}

function isText(value: mixed): boolean %checks {
  return typeof value === 'string';
}

export function show(value: mixed): string {
  if (isText(value)) return 'text ' + (value: any);
  if (typeof value === 'number') return 'number ' + String(value);
  return 'other ' + typeof value;
}

// An unannotated parameter takes any value.
export function twice(value) {
  return [value, value];
}

// A function that reads `arguments` takes any number of them.
export function count(first: string): number {
  return arguments.length;
}

export function firstOf<T>(items: Array<T>, fallback: T): T {
  return items.length > 0 ? items[0] : fallback;
}

export function asNumber(value: mixed): number {
  return (value as any) * 2;
}

// Collections created empty in an annotated object literal, then filled.
type Store = {
  byName: Map<string, Array<number>>,
  nested: {ids: Set<string>},
  label: string | (() => string),
};

export function createStore(): Store {
  const store: Store = {byName: new Map(), nested: {ids: new Set()}, label: 'store'};
  return store;
}

export function fill(store: Store, name: string, value: number): number {
  const list = store.byName.get(name) ?? [];
  list.push(value);
  store.byName.set(name, list);
  store.nested.ids.add(name);
  return list.length + store.nested.ids.size;
}
