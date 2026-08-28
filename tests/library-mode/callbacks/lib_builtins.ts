// CB6 builtin-name collision fixture: profile channels may share names with
// declaration-file ambients without claiming those bindings. isNaN must keep
// its standard-library lowering; parseInt is unreferenced channel capacity and
// must not be validated against lib.d.ts's optional-radix signature.
// `int` is a valid TypeScript identifier but a C keyword: C emission must
// dispatch it indirectly without inventing an `extern ... int(...)` symbol.
declare function int(x: number): number;

export function checkBuiltin(x: number): boolean {
  return isNaN(x);
}

export function callKeyword(x: number): number {
  return int(x);
}
