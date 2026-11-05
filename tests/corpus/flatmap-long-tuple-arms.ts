// A flatMap callback whose tuple arm has more than ten elements appends
// them in index order.
function spread(values: number[]): number[] {
  return values.flatMap((n) => {
    const base = n * 100;
    return n
      ? ([base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6, base + 7, base + 8, base + 9, base + 10, base + 11] as const)
      : [];
  });
}
console.log(spread([1, 0, 2]).join(","));
