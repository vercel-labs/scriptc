import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CFixture {
  /** The executable to write. */
  output: string;
  /** Every translation unit, as an absolute path. */
  sources: readonly string[];
  /** Flags for every compile and for the link (`-O1`, `-fsanitize=…`, `-D…`, `-I…`). */
  flags: readonly string[];
  /** Arguments only the link takes (`-lm`). */
  libraries?: readonly string[];
  /** How many translation units compile at once. */
  jobs?: number;
}

/** One clang invocation over a fixture's sources compiles them one after
 * another on one core, so a fixture that links most of the runtime spends
 * its whole build waiting behind `scr_lib.c`. Compile each translation unit
 * to its own object, several at once, then link: the same objects from the
 * same flags, in the wall time of the slowest unit instead of their sum. */
export async function buildCFixture(fixture: CFixture): Promise<void> {
  const { output, sources, flags, libraries = [] } = fixture;
  const jobs = Math.max(1, fixture.jobs ?? Math.min(8, availableParallelism()));
  const objectDir = `${output}.objects`;
  await mkdir(dirname(output), { recursive: true });
  await rm(objectDir, { recursive: true, force: true });
  await mkdir(objectDir);
  try {
    // Two sources may share a base name, so the index keeps objects apart.
    const objects = sources.map((source, index) =>
      join(objectDir, `${index}-${basename(source)}.o`),
    );
    let next = 0;
    const compileNext = async (): Promise<void> => {
      while (next < sources.length) {
        const index = next++;
        await execFileAsync("clang", [...flags, "-c", sources[index]!, "-o", objects[index]!], {
          maxBuffer: 64 << 20,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, sources.length) }, compileNext));
    // The link reads no source, so the language and preprocessor flags it is
    // handed with the rest are unused there by design.
    await execFileAsync(
      "clang",
      [...flags, "-Wno-unused-command-line-argument", ...objects, ...libraries, "-o", output],
      { maxBuffer: 64 << 20 },
    );
  } finally {
    await rm(objectDir, { recursive: true, force: true });
  }
}
