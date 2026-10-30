import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { checkerBackend } from "./checker-backend.js";
import { checkerExecutableIdentity } from "./lib-diagnostics.js";

/** Text entries kept between builds (the native compiler's cache). */
export interface CheckerFeatureStore {
  read(key: string): string | null;
  write(key: string, text: string): void;
}

let featureStore: CheckerFeatureStore | null = null;
const answers = new Map<string, boolean>();

/** Keeps the answers of checkerReadsLibrariesFromDisk between builds. */
export function setCheckerFeatureStore(store: CheckerFeatureStore | null): void {
  featureStore = store;
}

/**
 * Whether the tsc-ts at `executable` takes `--api --default-libraries-from-disk`, which has it read the files
 * of its default library directory from the disk instead of through the file system callbacks. tsc-ts releases
 * before it reject the flag, so it is asked once per executable identity: the stored answer, or else
 * `tsc-ts --api --default-libraries-from-disk` with an empty input, which exits with 0 when the flag is known
 * and with a usage error when it is not. tsgo is never asked.
 */
export function checkerReadsLibrariesFromDisk(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (checkerBackend(env) !== "tsc-ts") return false;
  const key = createHash("sha256")
    .update(JSON.stringify(["default-libraries-from-disk", checkerExecutableIdentity(executable)]))
    .digest("hex");
  const known = answers.get(key);
  if (known !== undefined) return known;
  const stored = featureStore?.read(key) ?? null;
  let answer: boolean;
  if (stored === "1" || stored === "0") answer = stored === "1";
  else {
    const probe = spawnSync(executable, ["--api", "--default-libraries-from-disk"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10_000,
    });
    answer = probe.error === undefined && probe.status === 0;
    // A probe that could not run says nothing about the flag: ask again next time.
    if (probe.error === undefined && probe.status !== null)
      featureStore?.write(key, answer ? "1" : "0");
  }
  answers.set(key, answer);
  return answer;
}
