// A call inside a stored expression can keep the value it was handed: here
// `stash` and `stashTable` push their argument into module-level sinks, so
// the array a factory returns still has a mutable alias. Only the stored
// value itself (a primitive, or a fresh construction) is non-escaping: the
// arguments of a call inside it escape, and each publication below is
// refused.
import type { Immutable } from "@scriptc/types";

const SINK: number[][] = [];
const TABLES: number[][][] = [];

function stash(v: number[]): number {
  SINK.push(v);
  return v.length;
}

function stashTable(v: number[][]): number {
  TABLES.push(v);
  return v.length;
}

function built(): number[] {
  const out: number[] = [];
  out.push(stash(out));
  return out;
}

function nestedBuilt(): number[][] {
  const out: number[][] = [];
  out.push([stashTable(out)]);
  return out;
}

const KEEP: Immutable<number[]> = built();
const NESTED_KEEP: Immutable<number[][]> = nestedBuilt();
SINK[0]!.push(7);
TABLES[0]!.push([8]);
console.log(KEEP.length, NESTED_KEEP.length);
