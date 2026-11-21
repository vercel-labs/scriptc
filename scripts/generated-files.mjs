/* The one recovery instruction every check that finds a committed generated
 * file stale prints, and the same sentence AGENTS.md gives a merge resolver.
 * Keep the wording identical in both places. */
export const REGEN_HINT =
  "on a merge conflict in a generated file, take either side and run `pnpm regen`";

/** A staleness error naming what is stale and the command that rewrites it. */
export function stale(subject, command) {
  return `${subject}; run ${command}.\n${REGEN_HINT}`;
}
