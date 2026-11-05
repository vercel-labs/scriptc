import { "add" as plus, type Total } from "./adder.ts";

export function viaStringName(): number {
  const total: Total = { total: 1 };
  const held = { plus };
  return held.plus.call(total, 2);
}
