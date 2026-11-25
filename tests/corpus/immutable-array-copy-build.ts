// Arrays built by copying out of an Immutable value are fresh. Pushing
// elements read from Immutable data (the push reaches its receiver through a
// compiler temporary) and filtering an Immutable array (which returns a new
// array) both leave no other reference to the result, so the result can be
// published as Immutable itself.
import type { Immutable } from "@scriptc/types";

const SOURCE: Immutable<number[]> = [3, 1, 4, 1, 5, 9];

function doubled(): number[] {
  const out: number[] = [];
  for (const v of SOURCE) out.push(v * 2);
  return out;
}

function evens(): number[] {
  return SOURCE.filter((v) => v % 2 === 0);
}

function indexed(): number[] {
  const out: number[] = [];
  for (let i = 0; i < SOURCE.length; i++) out.push(SOURCE[i]! + 1);
  return out;
}

const DOUBLED: Immutable<number[]> = doubled();
const EVENS: Immutable<number[]> = evens();
const INDEXED: Immutable<number[]> = indexed();

class Table {
  rows: Immutable<number[]> = [];
}
const t = new Table();
t.rows = SOURCE.filter((v) => v > 3);

console.log(DOUBLED.join(","), EVENS.join(","), INDEXED.join(","), t.rows.join(","));
