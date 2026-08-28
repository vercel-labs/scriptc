// Multi-instance fixture, instance A (prefix ma_): mutable module state the
// probe advances from A's dedicated thread, plus a deliberately trapping
// export (array index OOB — the runtime's own range trap) that must reach
// ONLY this instance's sink.
let calls = 0;

export function bump(x: number): number {
  calls++;
  return x + calls;
}

export function callsSeen(): number {
  return calls;
}

export function boom(i: number): number {
  const xs = [1, 2, 3];
  return xs[i]!;
}

console.log("multi-a ready");
