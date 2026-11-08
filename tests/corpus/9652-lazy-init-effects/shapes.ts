export interface Shape {
  name: string;
  sides: number;
}
// A table that only computes.
export const SHAPES: Shape[] = [
  { name: "triangle", sides: 3 },
  { name: "square", sides: 4 },
  { name: "pentagon", sides: 5 },
].map((shape) => ({ ...shape, name: shape.name.toUpperCase() }));
export function sides(name: string): number {
  for (const shape of SHAPES) if (shape.name === name) return shape.sides;
  return 0;
}
