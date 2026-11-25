// Regular expressions assembled from pieces at load.
const NUMBER = "0|[1-9]\\d*";
const WORD = "[a-zA-Z][a-zA-Z0-9-]*";
const PIECES: Record<string, string> = {
  version: `(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})`,
  tag: `(?:-(${WORD}(?:\\.${WORD})*))`,
  range: `(<|>)?=?\\s*(${NUMBER})(?:\\.(${NUMBER}))?`,
};
export const PATTERNS: Record<string, RegExp> = {};
for (const name of Object.keys(PIECES)) {
  PATTERNS[name] = new RegExp("^" + PIECES[name] + "$");
  PATTERNS[name + "Loose"] = new RegExp("[v=\\s]*" + PIECES[name], "i");
}
export function isVersion(text: string): boolean {
  return PATTERNS["version"]!.test(text);
}
