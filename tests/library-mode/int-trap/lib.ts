/* Ask 4's inbound declared-integer edge: `take`'s parameter is
 * profile-declared i64 (takeU's u64), so the generated wrapper
 * range-checks every HOST call — a value past ±(2^53 − 1) cannot ride
 * f64 exactly, and silent rounding is a coercion the author never wrote,
 * so the wrapper delivers the SC4012 host-contract trap instead.
 * In-range values convert exactly. */
let seen: number[] = [];

export function take(x: number): void {
  seen.push(x);
}

export function takeU(x: number): void {
  seen.push(x);
}

export function last(): number {
  return seen.length === 0 ? -1 : seen[seen.length - 1]!;
}
