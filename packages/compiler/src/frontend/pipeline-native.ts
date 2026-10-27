import { runFrontend, type Frontend, type FrontendOptions } from "./pipeline.js";
import { loadProgram } from "./program.js";
import { FrontendServices, type ComptimeEvaluator } from "./services.js";
import { createNativeTs7Api } from "./ts7/native-api.js";

/** Native callers supply the installed TS7 executable explicitly. The
 * returned frontend owns its final program and shared syntax services;
 * intermediate npm scout and fallback loads close as soon as replaced. */
export function runNativeFrontend(
  entryPath: string,
  executable: string,
  npmStatic?: readonly string[] | "auto" | "lib",
  externalTypes?: Readonly<Record<string, string>>,
  evaluateComptime?: ComptimeEvaluator,
  libraryNpmStatic: readonly string[] = [],
  options: FrontendOptions = {},
): Frontend {
  const services = new FrontendServices(
    (options) => createNativeTs7Api({ ...options, executable }),
    process.cwd(),
    evaluateComptime,
    undefined,
  );
  try {
    const frontend = runFrontend(
      entryPath,
      (path, options) =>
        loadProgram(path, services, {
          npmStatic: options.npmStatic ?? [],
          externalTypes: Object.entries(options.externalTypes ?? {}),
        }),
      npmStatic,
      externalTypes,
      libraryNpmStatic,
      options,
    );
    return {
      ...frontend,
      dispose: () => {
        try {
          frontend.dispose();
        } finally {
          services.close();
        }
      },
    };
  } catch (error) {
    services.close();
    throw error;
  }
}
