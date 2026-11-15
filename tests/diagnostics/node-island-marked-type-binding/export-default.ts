interface Shape {
  sides: number;
}

export function sides(shape: Shape): number {
  return shape.sides;
}

export default Shape;
