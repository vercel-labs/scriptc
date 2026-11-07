// readdir's value is its one-argument names listing. A slot that passes the
// options argument asks for the Dirent or recursive form, which only the
// direct call selects, so the value refuses by name there instead of
// answering names where Node answers entries.
import { readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";

async function entries(
  list: (path: string, options: { recursive: true }) => Promise<string[]>,
): Promise<number> {
  return (await list(".", { recursive: true })).length;
}
function entriesSync(list: (path: string, options: { recursive: true }) => string[]): number {
  return list(".", { recursive: true }).length;
}
console.log(await entries(readdir));
console.log(entriesSync(readdirSync));
