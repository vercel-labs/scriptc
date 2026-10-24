import { heavy } from "gtunloadedheavy";

console.log("lazy evaluated");

export function run(text: string): string {
  return heavy(text);
}
