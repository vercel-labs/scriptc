/** Node convenience entry. Native callers supply FrontendServices to
 * program.ts directly; each Node load owns all of its parser connections. */
import { dirname, resolve } from "node:path";
import {
  loadProgram as loadWithServices,
  checkPreflightTs7 as preflightWithHost,
} from "./program.js";
import { createNodeFrontendServices } from "./services-node.js";
import type { Ts7Host } from "./ts7/program-host.js";
import type { Defines } from "./defines.js";
export * from "./program.js";

export interface NodeProgramLoadOptions {
  npmStatic?: Iterable<string>;
  externalTypes?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined;
  define?: Defines | undefined;
}

export function loadProgram(
  entryPath: string,
  options?: NodeProgramLoadOptions,
): ReturnType<typeof loadWithServices> {
  const services = createNodeFrontendServices();
  try {
    const load = loadWithServices(entryPath, services, {
      npmStatic: [...(options?.npmStatic ?? [])],
      externalTypes:
        options?.externalTypes instanceof Map
          ? [...options.externalTypes]
          : Object.entries(options?.externalTypes ?? {}),
      define: options?.define,
    });
    return {
      ...load,
      dispose: () => {
        try {
          load.dispose();
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

export function checkPreflightTs7(
  entryPath: string,
  sharedHost?: Ts7Host,
): ReturnType<typeof preflightWithHost> {
  if (sharedHost !== undefined) return preflightWithHost(entryPath, sharedHost);
  const services = createNodeFrontendServices();
  try {
    const host = services.createProgramHost({ cwd: dirname(resolve(entryPath)) });
    try {
      return preflightWithHost(entryPath, host);
    } finally {
      host.close();
    }
  } finally {
    services.close();
  }
}
