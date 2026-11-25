// Dynamic code that receives a class instance keeps its Immutable fields
// out of reach: the computed-access helper's per-class branches must not be
// narrowed away when a class instance can be its receiver.
import type { Immutable } from "@scriptc/types";

const RULES: Immutable<number[]> = [1, 2, 3];

export class El {
  rules: readonly number[] = RULES;
  text = "";
}

export const root = new El();

function tamper(el: any, key: string): void {
  const got = el[key];
  got.push(4);
  el.text = "x";
}

tamper(root, "rules");
console.log(root.text);
