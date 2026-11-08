// A catalogue reshaped at load: groups of entries flattened into rows.
interface Unit {
  factor: number;
  symbol: string;
}
const CATALOG: Record<string, Record<string, Unit>> = {};
for (let g = 0; g < 40; g++) {
  const group: Record<string, Unit> = {};
  for (let u = 0; u < 50; u++) group["u" + g + "_" + u] = { factor: g * 100 + u, symbol: "s" + u };
  CATALOG["group" + g] = group;
}
export interface Row extends Unit {
  id: string;
  group: string;
}
export const UNITS: Row[] = Object.entries(CATALOG).flatMap(([group, units]) =>
  Object.entries(units).map(([id, unit]): Row => ({ ...unit, id, group })),
);
export function factor(id: string): number {
  for (const unit of UNITS) if (unit.id === id) return unit.factor;
  return 0;
}
