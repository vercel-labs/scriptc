// @dynamic
// Spread of dynamic operands: array spread of an `any` value into a
// static array (`[...base, ...dyn]`), object spread of an `any` value,
// and object spread of an index-signature record — literal defaults
// survive when the spread contributes nothing. (TS drops index
// signatures through spread, so the index-signature result is declared.)
export function mergeItems(base: string[], dyn: any): string[] {
  return [...base, ...dyn];
}
console.log(mergeItems(["a", "b"], ["c", "d"]).join(","));
console.log(mergeItems(["a"], [] as any).join(","));

export function cloneDict(opts: { [key: string]: any }): { [key: string]: any } {
  const merged: { [key: string]: any } = { timeout: 1000, ...opts };
  return merged;
}
console.log(cloneDict({ retries: 3 }).timeout, cloneDict({ retries: 3 }).retries);
console.log(cloneDict({}).timeout);

export function absorbDyn(opts: any): number {
  const merged = { timeout: 1000, ...opts };
  return merged.timeout;
}
console.log(absorbDyn({ timeout: 7 }), absorbDyn(null), absorbDyn(undefined));
