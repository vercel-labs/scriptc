export const __x = 1;
export const ___y = "three";
export let __count = 0;
export function __bump(): number {
  __count++;
  return __count;
}
export class __Point {
  a: number;
  b: number;
  constructor(a: number, b: number) {
    this.a = a;
    this.b = b;
  }
  sum(): number {
    return this.a + this.b;
  }
}
export const plain = "plain";
