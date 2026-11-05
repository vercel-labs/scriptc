// A dependency of the import()-only `lazy.ts` graph below. Its own static
// import names a package the project marks unloaded, so the graph rejects
// when `./lazy.ts` is imported — and equally when `./dep.ts` is imported
// directly.
import { heavy } from "gtunloadedheavy";

export function helper(text: string): string {
  return heavy(text);
}
