/* The Node frontend's semantic replay for the coverage verdict cache: an
 * entry whose only changed inputs are TypeScript sources with the same
 * tokens (comment-only edits) is reused, with its reported locations moved
 * to the edited text. */
import { frontendInputsSemanticallyMatch } from "../frontend/input-tracker.js";
import { rebaseSourceLocations, semanticallyEqualSource } from "../library/semantic-source.js";
import type { SemanticReplay } from "./verdict-cache.js";

export const commentOnlyReplay: SemanticReplay = (probes, sources, coverage) => {
  const previous = new Map<string, string>();
  for (const source of sources) previous.set(source.path, source.text);
  const match = frontendInputsSemanticallyMatch(probes, previous, semanticallyEqualSource);
  if (match === null || match.changed.length === 0) return null;
  const current = new Map(previous);
  for (const [path, text] of match.currentSources) current.set(path, text);
  const rebased = rebaseSourceLocations(structuredClone(coverage), previous, current);
  return {
    probes: match.snapshot,
    sources: [...current].map(([path, text]) => ({ path, text })),
    coverage: rebased,
  };
};
