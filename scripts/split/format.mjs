/* Formatting for the split tools. oxfmt reads its configuration from the
 * directory it runs in, its parents and the formatted files' directories,
 * and an oxfmt.config.ts there is code it runs. The tools format files in
 * a checkout they rewrite, which can be a pull request's, so they pass the
 * tools checkout's own configuration and turn the nested lookup off: no
 * configuration file of the rewritten checkout is read or run. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Formats `files` (paths relative to `cwd`) with the tools checkout's
 * oxfmt and configuration. */
export function formatFiles(toolsDir, files, { cwd, stdio }) {
  // With no file arguments oxfmt would format the whole directory.
  if (files.length === 0) return;
  execFileSync(
    join(toolsDir, "node_modules/.bin/oxfmt"),
    ["--config", join(toolsDir, ".oxfmtrc.jsonc"), "--disable-nested-config", ...files],
    { cwd, stdio },
  );
}
