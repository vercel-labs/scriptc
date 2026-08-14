// @dynamic
// An overload can present an island array as static. The callback still uses
// the void ABI, so the engine must not silently receive an erased return.
function values(): number[];
function values(): any {
  return [0, 1];
}

const pred: (n: number) => void = (n) => n;
console.log(values().filter(pred).join(","));
// The callback's erased return makes this unsupported.
