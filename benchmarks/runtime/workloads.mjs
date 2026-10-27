/* The runtime benchmark workloads: one JSON file per workload in
 * workloads/, named after the workload, next to the entry programs. A file
 * holds the workload's entry, args and options; changes that add
 * different workloads add different files. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CATEGORIES = ["cpu", "startup", "server"];

/* Server workloads run a listening program; startup-bound ones time
 * several sequential launches per sample. */
export const workloadCategory = (w) =>
  w.kind === "server" ? "server" : (w.launches ?? 1) > 1 ? "startup" : "cpu";

/* The workloads of the suite at `suite` (a benchmarks/runtime directory),
 * by category and then name. A checkout from before the per-workload files
 * lists them in workloads.json, in its own order. */
export function readWorkloads(suite) {
  const legacy = join(suite, "workloads.json");
  if (existsSync(legacy)) return JSON.parse(readFileSync(legacy, "utf8")).workloads;
  const dir = join(suite, "workloads");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: file.slice(0, -".json".length),
      ...JSON.parse(readFileSync(join(dir, file), "utf8")),
    }))
    .sort(
      (a, b) =>
        CATEGORIES.indexOf(workloadCategory(a)) - CATEGORIES.indexOf(workloadCategory(b)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}
