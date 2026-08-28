// Tuple types reached through TypeReference shapes: a generic conditional
// resolving to a tuple (the `ResolveTuple` spread/infer idiom) and a generic
// tuple alias instantiation hand the checker reference-to-tuple shapes where
// the type mapping reads tuple element data — the path the SC0004 panic
// guard narrows (tupleShapeOf resolves the reference's target explicitly,
// and a panicked shape query degrades to an actionable diagnostic, never a
// crashed compile). Regression corpus for the 2726 hardening.
type DeepTuple<T extends any[]> = [...T];
export type ResolveTuple<T> = T extends [infer A, ...infer Rest] ? [A, DeepTuple<Rest>] : [];
type T1 = ResolveTuple<[1, 2, 3]>;
const x: T1 = [1, [2, 3]] as [1, [2, 3]];
console.log("tuple-ok", x[0], x[1][0]);
export function useTuple(t: [number, string]) {
  return t[0] + t[1].length;
}
console.log(useTuple([2, "hi"]));
type Pair<A, B> = [A, B];
const p: Pair<number, string> = [7, "w"];
console.log(p[0], p[1]);
