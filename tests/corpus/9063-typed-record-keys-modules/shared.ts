// What several modules share: a registry they add handlers to at load, and
// the parts of the strings and patterns they build.
export const handlers = new Map<string, (x: number) => number>();
export function register(name: string, handler: (x: number) => number): void {
  handlers.set(name, handler);
}
export const PREFIX = "unit";
export const MARKS =
  "\\s\\p{P}\\p{S}" +
  "\\u3000-\\u307f\\u3100-\\u317f\\u3200-\\u327f\\u3300-\\u337f\\u3400-\\u347f\\u3500-\\u357f\\u3600-\\u367f\\u3700-\\u377f\\u3800-\\u387f\\u3900-\\u397f\\u3a00-\\u3a7f\\u3b00-\\u3b7f\\u3c00-\\u3c7f\\u3d00-\\u3d7f\\u3e00-\\u3e7f\\u3f00-\\u3f7f";
