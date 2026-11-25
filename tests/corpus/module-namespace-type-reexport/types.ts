export interface Shape {
  a: number;
}

export type Alias = Shape;

export const runtimeValue = 1;

export class Klass {
  m(): void {}
}

export function fn(): void {}
