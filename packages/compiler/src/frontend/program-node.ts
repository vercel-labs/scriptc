/** Node convenience entry. Native callers supply FrontendServices to
 * program.ts directly; each Node load owns all of its parser connections. */
import { dirname, resolve } from "node:path";
import {
  loadProgram as loadWithServices,
  checkPreflightTs7 as preflightWithHost,
} from "./program.js";
import { createNodeFrontendServices } from "./services-node.js";
import type { Ts7Host } from "./ts7/program-host.js";
import type { FrontendServices } from "./services.js";
export * from "./program.js";

export interface NodeProgramLoadOptions {
  npmStatic?: Iterable<string>;
  externalTypes?: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined;
}

function serviceOptions(options: NodeProgramLoadOptions | undefined) {
  return {
    npmStatic: [...(options?.npmStatic ?? [])],
    externalTypes:
      options?.externalTypes instanceof Map
        ? [...options.externalTypes]
        : Object.entries(options?.externalTypes ?? {}),
  };
}

/** A load on services the caller owns (and closes). */
export function loadProgramWithServices(
  entryPath: string,
  services: FrontendServices,
  options?: NodeProgramLoadOptions,
): ReturnType<typeof loadWithServices> {
  return loadWithServices(entryPath, services, serviceOptions(options));
}

export function loadProgram(
  entryPath: string,
  options?: NodeProgramLoadOptions,
): ReturnType<typeof loadWithServices> {
  const services = createNodeFrontendServices();
  try {
    const load = loadWithServices(entryPath, services, serviceOptions(options));
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
  const services = createNodeFrontendServices();
  try {
    const host = sharedHost ?? services.createProgramHost({ cwd: dirname(resolve(entryPath)) });
    try {
      return preflightWithHost(entryPath, host, services);
    } finally {
      if (sharedHost === undefined) host.close();
    }
  } finally {
    services.close();
  }
}
