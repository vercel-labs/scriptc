import * as fs from "node:fs";
import { promisify } from "node:util";
import { EARLY, banner } from "./layout.ts";

// A promisified library function has no module storage: its calls lower
// directly. Its declaration still has a place in the module's evaluation.
const readStock = promisify(fs.readFile);
export { readStock as slurp };

export function peek(path: string): Promise<string> {
  return readStock(path, "utf8");
}

export async function summarize(path: string): Promise<string> {
  const text = await readStock(path, "utf8");
  return EARLY.join(" ; ") + " / " + banner(text.trim().split("\n"));
}
