// The typed half of the program: a class with an Immutable array field.
// Node erases the annotation; the field is an ordinary array.
import type { Immutable } from "@scriptc/types";

const RULES: Immutable<number[]> = [1, 2, 3];

export class El {
  rules: readonly number[] = RULES;
  text = "";
}

export function count(el: El): number {
  let t = 0;
  for (const r of el.rules) t += r;
  return t;
}

export const root = new El();
