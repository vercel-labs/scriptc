// Callbacks that declare fewer parameters than the slot they are stored in:
// the slot's callers pass its arguments, and a callback ignores the ones it
// does not name.
function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): S {
  return reducer(initial, undefined as unknown as A);
}
const incremented: number = useReducer((count: number) => count + 1, 0);
console.log("incremented", incremented);

function take(cb: (value: string, extra: number) => void): void {
  cb("v", 7);
}
const one = (value: string) => {
  console.log("one", value);
};
take(one);

const none = () => {
  console.log("none");
};
take(none);

const reducer = (count: number) => count + 2;
const wide: (state: number, action: string) => number = reducer;
console.log("wide", wide(1, "ignored"));
