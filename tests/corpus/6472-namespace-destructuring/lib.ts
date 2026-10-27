export function add(a: number, b: number): number {
  return a + b;
}

export const label = "lib";

export let counter = 1;

export function bump(): void {
  counter++;
}

export class Shape {
  side: number;
  constructor(side: number) {
    this.side = side;
  }
  area(): number {
    return this.side * this.side;
  }
}
