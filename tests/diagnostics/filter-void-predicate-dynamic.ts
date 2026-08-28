// @dynamic
// The void ABI remains a static fence even with the dynamic engine enabled.
const pred: (n: number) => void = (n) => n;
console.log([0, 1].filter(pred).join(","));
// The callback's erased return makes this unsupported.
