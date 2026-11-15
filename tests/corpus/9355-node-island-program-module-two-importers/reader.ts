// A module of the program that compiles natively and imports the island
// module too: the island module's second importer.
import { installPatch } from "./patch.ts";

export function describePatch(): string {
  return `${typeof installPatch} ${installPatch.name}`;
}
