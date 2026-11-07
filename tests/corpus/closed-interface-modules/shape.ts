export interface Shape {
  readonly kind: string;
  area(): number;
  scaled(by: number): Shape;
}
export interface Sized {
  size(): number;
}
