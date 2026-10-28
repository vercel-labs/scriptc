import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  toolchainEnvironmentCachePolicy,
  toolchainEnvironmentFingerprint,
} from "../backend/toolchain-environment.js";
import type { NativeToolchain } from "./toolchain.js";
import { contentDigest, type NativeCache } from "./cache.js";
import {
  commandPath,
  identity,
  type InputIdentity,
  stillMatches,
  tracePaths,
  validIdentity,
} from "./executable-cache.js";

/** A recorded linker job. In `job`, a number is the index of one of the link's
 * own paths (its inputs and output); `inputs` are the identities of the
 * other files and directories the job and the driver's `-v` lines name. */
interface LinkerJobEntry {
  schema: "scriptc.linker-job.v1";
  /** null when the driver's job could not be recorded: the link runs through
   * the driver. */
  job: (string | number)[] | null;
  inputs: InputIdentity[];
}

/** A link that ran as its recorded job: the linker's output, and the
 * identities the job depends on besides the link's own paths. */
export interface LinkerJobRun {
  output: string;
  driverInputs: InputIdentity[];
}

/** One link's use of LinkerJobs, with its own paths and stage. */
export interface LinkerJobLink {
  run(args: string[], list: boolean): LinkerJobRun | null;
  record(args: string[], output: string, driverInputs?: InputIdentity[]): void;
}

const MAX_ENTRY_BYTES = 1024 * 1024;

function validEntry(value: unknown, paths: number): value is LinkerJobEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Partial<LinkerJobEntry>;
  if (entry.schema !== "scriptc.linker-job.v1" || !Array.isArray(entry.inputs)) return false;
  if (!entry.inputs.every(validIdentity)) return false;
  if (entry.job === null) return true;
  if (!Array.isArray(entry.job) || typeof entry.job[0] !== "string") return false;
  const used = new Set<number>();
  for (const token of entry.job) {
    if (typeof token === "string") continue;
    if (!Number.isInteger(token) || token < 0 || token >= paths || used.has(token)) return false;
    used.add(token);
  }
  return used.size === paths;
}

function underRoots(text: string, roots: string[]): boolean {
  return roots.some((root) => text.includes(root));
}

/** The arguments of one job line as the driver prints them: with `-###`
 * each argument is quoted, with `-v` only the program and the arguments that
 * contain a space, `"`, `\` or `$`; a quoted argument escapes `"`, `\` and
 * `$` with `\`. Null for any other line. */
function jobArguments(line: string): string[] | null {
  const pattern = /\s*(?:"((?:\\.|[^"\\])*)"|([^\s"\\]+))/y;
  const args: string[] = [];
  let end = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    args.push(match[1] === undefined ? match[2]! : match[1].replace(/\\(.)/g, "$1"));
    end = pattern.lastIndex;
  }
  return args.length === 0 || line.slice(end).trim() !== "" ? null : args;
}

/**
 * Linux links through a clang driver with lld. The driver only starts ld.lld
 * with a job it derives from its arguments, its environment, its own
 * installation and the system's (startup objects, the GCC installation,
 * library directories). The job is recorded once per driver identity,
 * arguments and environment, with the identities of the files and
 * directories it and the driver's `-v` lines name. A later link whose recorded
 * paths still have those identities runs ld.lld with the job directly; every
 * other link runs through the driver.
 */
export class LinkerJobs {
  /** A job run that failed in this build: later links run through the
   * driver, which reports the error. */
  private failed = false;

  private constructor(
    private readonly cache: NativeCache,
    private readonly driver: string,
    private readonly driverIdentity: InputIdentity,
  ) {}

  /** Null unless the link is a host Linux link through a clang driver with
   * `-fuse-ld=lld` (`lld`, the link's lld arguments), outside the sanitizer,
   * with a native cache and a toolchain environment that allows complete
   * artifacts. */
  static open(
    cache: NativeCache | null,
    toolchain: NativeToolchain,
    lld: readonly string[],
    sanitize: boolean,
  ): LinkerJobs | null {
    const target = toolchain.target;
    if (
      cache === null ||
      sanitize ||
      target.platform !== "linux" ||
      // A cross-target link keeps the driver.
      target.llvmTriple !== toolchain.helper.defaultTarget ||
      !lld.includes("-fuse-ld=lld") ||
      process.env["SCRIPTC_LINKER"] !== undefined ||
      !toolchainEnvironmentCachePolicy().completeArtifacts
    )
      return null;
    try {
      const driver = commandPath(toolchain.linker);
      if (!/^clang(-\d+)?$/.test(basename(realpathSync(driver)))) return null;
      return new LinkerJobs(cache, driver, identity(driver));
    } catch {
      return null;
    }
  }

  /** The link whose own inputs and output are `paths`, in `stage`. */
  link(paths: readonly string[], stage: string): LinkerJobLink {
    return {
      run: (args, list) => this.run(args, paths, stage, list),
      record: (args, output, driverInputs) => this.record(args, paths, stage, output, driverInputs),
    };
  }

  /** The entry key of the link `args` with its own `paths`, or null when
   * the arguments name the stage besides those paths. */
  private key(args: readonly string[], paths: readonly string[], roots: string[]): string | null {
    const index = new Map(paths.map((path, i) => [path, i]));
    if (index.size !== paths.length || !paths.every((path) => args.includes(path))) return null;
    if (args.some((arg) => !index.has(arg) && underRoots(arg, roots))) return null;
    const shape = args.map((arg) => {
      const at = index.get(arg);
      return at === undefined ? arg : { path: at, extension: extname(arg) };
    });
    return contentDigest(
      JSON.stringify({
        schema: 1,
        driver: this.driverIdentity,
        args: shape,
        environment: toolchainEnvironmentFingerprint(),
        cwd: process.cwd(),
        path: process.env["PATH"] ?? null,
      }),
    );
  }

  /**
   * Runs the link that the driver arguments `args` describe as its recorded
   * job. `paths` are the link's own inputs and output among `args`, which may
   * differ from build to build; `stage` is the directory they are in. Without
   * an entry, or with one whose job names a path that changed since it was
   * recorded, `list` records the job first with the driver's `-v -###`;
   * otherwise the caller links through the driver and passes its `-v` output
   * to record(), which records it again. Null when the link has to run
   * through the driver: no job is recorded, or the job failed.
   */
  run(
    args: readonly string[],
    paths: readonly string[],
    stage: string,
    list: boolean,
  ): LinkerJobRun | null {
    if (this.failed) return null;
    try {
      const roots = [resolve(stage), realpathSync(stage)];
      const key = this.key(args, paths, roots);
      if (key === null) return null;
      let entry = this.fresh(this.read(key, paths.length));
      if (entry === null && list) {
        const result = spawnSync(this.driver, [...args, "-v", "-###"], {
          encoding: "utf8",
          stdio: "pipe",
        });
        if (result.error !== undefined || result.status !== 0 || result.signal !== null)
          return null;
        entry = this.store(key, result.stdout + "\n" + result.stderr, paths, roots);
      }
      if (entry === null || entry.job === null) return null;
      const job = entry.job.map((token) => (typeof token === "number" ? paths[token]! : token));
      const result = spawnSync(job[0]!, job.slice(1), {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
        this.failed = true;
        return null;
      }
      return { output: result.stdout + "\n" + result.stderr, driverInputs: entry.inputs };
    } catch {
      return null;
    }
  }

  /** `entry`, or null when a path its job names changed since it was
   * recorded: the next link through the driver records the job again. An
   * entry without a job, a link the driver cannot hand to one ld.lld job,
   * stays. */
  private fresh(entry: LinkerJobEntry | null): LinkerJobEntry | null {
    return entry !== null && entry.job !== null && !stillMatches(entry.inputs) ? null : entry;
  }

  private read(key: string, paths: number): LinkerJobEntry | null {
    const bytes = this.cache.read("linker-job", key, MAX_ENTRY_BYTES);
    if (bytes === null) return null;
    try {
      const entry: unknown = JSON.parse(bytes.toString("utf8"));
      return validEntry(entry, paths) ? entry : null;
    } catch {
      return null;
    }
  }

  /** Records the job of the link `args` from `output`, the `-v` output of
   * the driver's successful link, unless an entry exists. `driverInputs`
   * are the identities of the paths `output` names, when the caller has
   * them. */
  record(
    args: readonly string[],
    paths: readonly string[],
    stage: string,
    output: string,
    driverInputs?: InputIdentity[],
  ): void {
    try {
      const roots = [resolve(stage), realpathSync(stage)];
      const key = this.key(args, paths, roots);
      if (key !== null && this.fresh(this.read(key, paths.length)) === null)
        this.store(key, output, paths, roots, driverInputs);
    } catch {
      /* The next link records it. */
    }
  }

  /** Stores the entry for `output`, the driver's `-v` lines and job. */
  private store(
    key: string,
    output: string,
    paths: readonly string[],
    roots: string[],
    driverInputs?: InputIdentity[],
  ): LinkerJobEntry {
    const lines = output.split(/\r?\n/).filter((line) => line.startsWith(' "'));
    const job = lines.length === 1 ? this.jobOf(jobArguments(lines[0]!), paths, roots) : null;
    const entry: LinkerJobEntry = {
      schema: "scriptc.linker-job.v1",
      job,
      inputs: job === null ? [] : (driverInputs ?? tracePaths(output, true, roots).map(identity)),
    };
    this.cache.write("linker-job", key, JSON.stringify(entry));
    return entry;
  }

  /** `job` with each of `paths` as its index: null unless the job runs
   * ld.lld and names each of the paths once, as one whole argument, and names
   * nothing else in the stage. */
  private jobOf(
    job: string[] | null,
    paths: readonly string[],
    roots: string[],
  ): (string | number)[] | null {
    if (job === null || job.length === 0) return null;
    if (!isAbsolute(job[0]!) || basename(job[0]!) !== "ld.lld") return null;
    const index = new Map(paths.map((path, i) => [path, i]));
    const used = new Set<number>();
    const tokens: (string | number)[] = [];
    for (const arg of job) {
      const at = index.get(arg);
      if (at === undefined) {
        if (underRoots(arg, roots)) return null;
        tokens.push(arg);
      } else {
        if (used.has(at)) return null;
        used.add(at);
        tokens.push(at);
      }
    }
    return used.size === paths.length ? tokens : null;
  }
}
