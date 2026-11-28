// a.push(...src) / unshift where src is a FRESH .map() result whose element
// record is a width lift of the receiver's element (one more optional
// field): the mapped elements are temporaries, so the copy into the
// receiver's layout is unobservable. A named array spread repeatedly stays
// refused (tests/diagnostics/fresh-spread-repeated.ts). Node is the oracle.
type Base = { error: unknown; index: number };
type WithRequested = { kind: string; index: number; error: unknown; requested?: number };

const failures: WithRequested[] = [];
const batch = {
  downloadFailures: [
    { error: "x", index: 1 },
    { error: null, index: 2 },
  ],
};
failures.push(
  ...batch.downloadFailures.map(({ error, index }) => ({
    kind: "download" as const,
    index,
    error,
  }))
);
failures.unshift(
  ...batch.downloadFailures.map(({ error, index }) => ({
    kind: "batch" as const,
    index,
    error,
  }))
);
console.log(JSON.stringify(failures));
console.log("length:", failures.length);
