import { loads } from "./state.ts";

loads.push("b");

export const name = "b";

export function id(): string {
  return `${name}#${loads.length}`;
}
