// 2716 unknown[] + unknown narrowing (LIST 4.1 + 4.5)
export function createPool(n: number) {
  return Array.from({ length: n }).map((_, i) => i * 2);
}
console.log(createPool(5).join(","));
console.log(createPool(0).length);

export function processDynamic(data: unknown): string {
  return typeof data === "string" ? data : "default";
}
console.log(processDynamic("hi"));
console.log(processDynamic(42));
console.log(processDynamic(undefined));

const arr: unknown[] = ["a", 1, true, null];
console.log(arr.length, String(arr[0]), String(arr[1]));
