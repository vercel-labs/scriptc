import { heavy } from "gtunloadedheavy";
import { helper } from "./dep.ts";

console.log("lazy evaluated");

export function run(text: string): string {
  return helper(text) + heavy(text);
}
