export class Gauge {
  private level = 0;
  fill(amount: number): number {
    this.level += amount;
    return this.level;
  }
}
let touched = 0;
// An exported binding typed as the class and initialized with a Proxy.
export const shared: Gauge = new Proxy({} as Gauge, {
  get(_target: any, key: string | symbol): any {
    touched++;
    return key === "fill" ? (amount: number) => amount * touched : undefined;
  },
});
export function touches(): number {
  return touched;
}
