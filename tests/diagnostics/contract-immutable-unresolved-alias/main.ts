// @ts-nocheck
// The tsconfig path alias names no module, so the Immutable marker cannot be
// followed. The annotation must be reported (SC7006) rather than skipped:
// the write below would otherwise go unchecked. @ts-nocheck keeps the
// unresolved import from stopping the compile before contract checking, so
// this fixture pins the contract diagnostic itself.
import type { Immutable } from "@missing/frozen";

const ROWS: Immutable<number[]> = [1, 2];
(ROWS as number[]).push(3);
console.log(ROWS.length);
