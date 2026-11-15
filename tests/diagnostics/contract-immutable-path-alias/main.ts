// The Immutable marker is only reachable through a tsconfig path alias: the
// import specifier is neither relative nor the contract module itself. The
// prefilter must resolve every specifier the program resolves, or the
// annotation compiles as if it were never written and the write below goes
// unchecked.
import type { Immutable } from "@frozen/frozen";

const ROWS: Immutable<number[]> = [1, 2];
(ROWS as number[]).push(3);
console.log(ROWS.length);
