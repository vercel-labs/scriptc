// K4 fixture: init re-run determinism. Module state (a scalar, a
// refcounted array, the run-once module guards) fully resets between
// sessions — two init calls produce identical observable outputs, and
// under the sanitize flavor the reset seam asserts zero live heap between
// sessions (the library RC-audit counters).
let counter = 0;
const seen: string[] = [];

export function bump(): number {
  counter = counter + 1;
  return counter;
}

export function note(s: string): number {
  seen.push(s);
  return seen.length;
}

export function recall(): string {
  return seen.join(",");
}

// Exercise the runtime's lazy sparse UTF-16 side metadata before every
// library re-init. The heap string itself becomes unreachable at the reset;
// the cache must release its owned checkpoints too.
export function indexedUnicode(): number {
  const s = "aé😀é".repeat(12000);
  const n = Math.floor(s.length / 2);
  return s.length + s.charCodeAt(n) + s.slice(n - 1, n + 2).length;
}

console.log(`session start counter=${counter}`);
