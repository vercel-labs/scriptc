// The library's typed export over untyped code (work.mjs).
import { runAll } from "./work.mjs";

export function run(): number {
  return runAll() as number;
}
