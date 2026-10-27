// Map support boundaries at lowering. Keep accepted adjacent forms here
// as well so widening the value domain removes its old diagnostic.

// Boolean keys compile alongside the remaining value and method fences.
const byFlag = new Map<boolean, string>();

// Function values compile (closures keep their identity in the slot).
const handlers = new Map<string, () => void>();

// Typed nested Maps retain their identity and are supported.
const nested = new Map<string, Map<string, number>>();

// Boolean-keyed parameter slots share the supported key domain.
function useFlags(m: Map<boolean, number>): number {
  return m.size;
}

// Nullable Map views are supported; no diagnostic should appear here.
function maybeMap(cond: boolean): Map<string, number> | undefined {
  return undefined;
}

// Maps as array elements now preserve references without a diagnostic.
const rows: Map<string, number>[] = [];

// Maps are not JSON (Node stringifies them as the useless "{}" husk;
// scriptc rejects instead of shipping that).
const m = new Map<string, number>();
console.log(JSON.stringify(m));

// Map methods have no bound-value form — call them directly.
const getter = m.get;
// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
useFlags(new Map<boolean, number>());
maybeMap(true);
