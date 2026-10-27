export const VERSION = "1.2";
export function circle(r) { return { kind: "circle", area: Math.PI * r * r }; }
export function square(s) { return { kind: "square", area: s * s }; }
export class Box { constructor(size) { this.size = size; } }
