/* The warnings a successful `build` reports on stderr, grouped the way the
 * build prints them: configuration settings the build does not use, type
 * patches that did not apply, a start-up failure, the divergence band, and the
 * performance warning.
 *
 * Both the CLI and the launcher's cached-build fast path (packages/cli/src/
 * bootstrap.ts) render through here. A restored build replays the warnings its
 * build recorded, so the same function has to produce the bytes the build
 * printed, or a cache hit would look different from the build that filled the
 * cache. */
import { readFileSync } from "node:fs";
import { isTypePatchCode, type ScrDiagnostic } from "./diagnostic.js";
import { isPerformanceCode, renderPerformanceWarnings } from "./dynamic-tier.js";
import {
  renderConfigWarnings,
  renderStartupWarnings,
  renderTypePatchWarnings,
  renderWarnings,
  type RenderOptions,
} from "./render.js";

/** The options that drop a warning a build would otherwise report. */
export interface BuildWarningOptions {
  /** `--no-dynamic-tier-warning`: the performance warning. */
  dynamicTier?: boolean;
  /** `--no-copy-warning`: SC6001. */
  copy?: boolean;
  /** `--no-key-order-warning`: SC6014. */
  keyOrder?: boolean;
}

/** The warnings a build reports: `warnings` minus the ones its options
 * silence. */
export function buildWarnings(
  warnings: readonly ScrDiagnostic[],
  options: BuildWarningOptions = {},
): ScrDiagnostic[] {
  return warnings.filter(
    (d) =>
      (options.dynamicTier !== false || !isPerformanceCode(d.code)) &&
      (options.copy !== false || d.code !== "SC6001") &&
      (options.keyOrder !== false || d.code !== "SC6014"),
  );
}

/** The stderr text of a build's warnings, without the trailing newline. */
export function renderBuildWarnings(
  warnings: readonly ScrDiagnostic[],
  sourceTextByFile: Map<string, string>,
  options: BuildWarningOptions & RenderOptions = {},
): string {
  const config = warnings.filter((d) => d.code === "SC8004");
  const patches = warnings.filter((d) => isTypePatchCode(d.code));
  const startup = warnings.filter((d) => d.code === "SC6201");
  const divergences = warnings.filter(
    (d) =>
      !isPerformanceCode(d.code) &&
      d.code !== "SC8004" &&
      d.code !== "SC6201" &&
      !isTypePatchCode(d.code),
  );
  const performance = warnings.filter((d) => isPerformanceCode(d.code));
  const sections: string[] = [];
  if (config.length > 0) sections.push(renderConfigWarnings(config, sourceTextByFile, options));
  if (patches.length > 0)
    sections.push(renderTypePatchWarnings(patches, sourceTextByFile, options));
  if (startup.length > 0) sections.push(renderStartupWarnings(startup, sourceTextByFile, options));
  if (divergences.length > 0) sections.push(renderWarnings(divergences, sourceTextByFile, options));
  if (performance.length > 0) sections.push(renderPerformanceWarnings(performance));
  return sections.join("\n\n");
}

/** The source text a build's warnings point into, for their code frames. A
 * restored build keeps the text of every file whose on-disk text changed
 * since the build; the others are read back from disk. */
export function warningSourceTexts(
  warnings: readonly ScrDiagnostic[],
  stored: Record<string, string> | undefined,
): Map<string, string> {
  const texts = new Map<string, string>();
  for (const w of warnings) {
    if (texts.has(w.loc.file)) continue;
    const kept = stored?.[w.loc.file];
    if (kept !== undefined) {
      texts.set(w.loc.file, kept);
      continue;
    }
    try {
      texts.set(w.loc.file, readFileSync(w.loc.file, "utf8"));
    } catch {
      // The frame is omitted; the message stands alone.
    }
  }
  return texts;
}
