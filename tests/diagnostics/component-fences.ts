// SC2009: supported shapes over a component type outside its slot — the
// container is not the blocker, and each message names the component.

// Boolean Map keys remain outside the supported key domain.
const byFlag = new Map<boolean, string>();
console.log(byFlag);

// Map values have no slot for URLSearchParams.
const queries = new Map<string, URLSearchParams>();
console.log(queries);

// Boolean Set elements remain outside the supported element domain.
const flags = new Set<boolean>();
console.log(flags);

// Arrays hold Map elements; retain the accepted adjacent form.
const rows: Map<string, number>[] = [];
console.log(rows);

// Nullable Maps compile and remain as working context.
function report(maybe: Map<string, number> | undefined): number {
  return maybe === undefined ? 0 : maybe.size;
}
console.log(report(undefined));

// Typed rest values now compile; retained here as working context for the
// component-type failures below.
const sum = (...xs: number[]): number => xs.length;
const storedSum = sum;
console.log(storedSum(1, 2));

// A function's return type carries the failure. The value arrives through
// a cast, not an ambient declare (a declare-rooted chain would compile to
// Node's ReferenceError at the root instead).
const makeWeak = (0 as unknown) as () => WeakRef<object>;
const storedMake = makeWeak;
console.log(storedMake());

// A record member's type carries the failure.
interface Holder {
  label: string;
  cache: WeakRef<object>;
}
const held = (0 as unknown) as Holder;
const kept = held;
console.log(kept.label);
