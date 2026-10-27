import { type AInfo } from "./a.ts";

export function b(): string {
  const info: AInfo = { tag: "b" };
  return info.tag;
}
console.log("b evaluated");
