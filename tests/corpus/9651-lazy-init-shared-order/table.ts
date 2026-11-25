import { id } from "./ids.ts";

export interface Row {
  id: number;
  name: string;
  tags: string[];
}
// Built at load from literals and the shared counter: no effect, no input.
export const ROWS: Row[] = ["alpha", "beta", "gamma"].map((name) => ({
  id: id("table"),
  name,
  tags: [name.slice(0, 1)],
}));
export const BY_NAME: Map<string, Row> = new Map(ROWS.map((row): [string, Row] => [row.name, row]));
export function find(name: string): Row | undefined {
  return BY_NAME.get(name);
}
