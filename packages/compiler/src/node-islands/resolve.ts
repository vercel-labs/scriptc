/** `require.resolve(spec)` from `fromFile` for island code (scope-B NI-4).
 * The Node-hosted compiler installs the resolver (index.ts, Node's own
 * createRequire); the self-hosted compiler builds no islands and never
 * installs one. Throws when the specifier does not resolve. */
type IslandResolver = (fromFile: string, spec: string) => string;

let islandResolver: IslandResolver | null = null;

export function setIslandResolver(resolver: IslandResolver): void {
  islandResolver = resolver;
}

export function resolveFrom(fromFile: string, spec: string): string {
  if (islandResolver === null) throw new Error(`no module resolver for '${spec}'`);
  return islandResolver(fromFile, spec);
}
