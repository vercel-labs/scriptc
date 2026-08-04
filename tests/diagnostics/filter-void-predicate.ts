// `.filter()` takes truthy (non-boolean) predicate results, but NOT a
// `void`-returning one. void is a TYPE erasure, not a runtime value: TS
// lets a value-returning function sit in a void-returning slot, so the
// predicate's real answer can be truthy while the compiled ABI has already
// discarded it — under Node `[0, 1].filter(pred)` below is `[1]`. Fenced
// until the returned value can be preserved through the void ABI.
const pred: (n: number) => void = (n) => n;
console.log([0, 1].filter(pred).join(","));
