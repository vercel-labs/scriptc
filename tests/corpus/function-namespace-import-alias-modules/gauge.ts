export function gauge(n: number): string {
  return n + gauge.unit;
}
export namespace gauge {
  export let unit = "m";
  export const digits = 2;
  export function twice(n: number): number {
    return n * 2;
  }
}
export function rescale(unit: string): void {
  gauge.unit = unit;
  Object.assign(gauge, { digits: 5, twice: (n: number): number => n * 20 });
}
