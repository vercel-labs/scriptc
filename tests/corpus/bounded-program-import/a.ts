import { loads } from "./state.ts";

loads.push("a");

export const name = "a";

export function id(): string {
  return `${name}#${loads.length}`;
}
