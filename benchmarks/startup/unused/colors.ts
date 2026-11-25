export interface Color {
  name: string;
  red: number;
  green: number;
  blue: number;
  hex: string;
}
const HEX = "0123456789abcdef";
function pair(value: number): string {
  return HEX.charAt(value >> 4) + HEX.charAt(value & 15);
}
// A table of records derived at load from a smaller one.
const BASE: Omit<Color, "hex">[] = [];
for (let i = 0; i < 4096; i++)
  BASE.push({ name: "c" + i, red: (i * 7) & 255, green: (i * 13) & 255, blue: (i * 29) & 255 });
export const COLORS: Color[] = BASE.map((color) => ({
  ...color,
  hex: "#" + pair(color.red) + pair(color.green) + pair(color.blue),
}));
export const BY_NAME: Map<string, Color> = new Map();
for (const color of COLORS) BY_NAME.set(color.name, color);
export function hex(name: string): string {
  return BY_NAME.get(name)?.hex ?? "";
}
