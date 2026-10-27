/** Allocation-heavy loops (lowering reached bodies and generic instances, emitting LLVM
 * functions) call `relieveHeapPressure` between units of work. It does nothing unless the process
 * installed a check with `setHeapPressureCheck` (collectGarbageUnderHeapPressure in
 * heap-collection.ts). `phase` is true where a phase that allocates without these calls ends. */
let check: (phase: boolean) => void = () => {};

export function relieveHeapPressure(phase = false): void {
  check(phase);
}

export function setHeapPressureCheck(next: (phase: boolean) => void): void {
  check = next;
}
