import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { FrontendServices, programHostLoads } from "./services.js";
import type { FlowNode } from "./flow/index.js";
import { Ts7Api } from "./ts7/rpc-api.js";
import { evaluateNodeComptime } from "./comptime-node.js";

export function createNodeFrontendServices(): FrontendServices {
  const services = new FrontendServices(
    (options) => new Ts7Api(options),
    process.cwd(),
    evaluateNodeComptime,
    {
      resolve: (fromFile, specifier, paths) => {
        const require = createRequire(pathToFileURL(fromFile));
        return paths === undefined
          ? require.resolve(specifier)
          : require.resolve(specifier, { paths: [...paths] });
      },
      lookupPaths: (fromFile, specifier) =>
        createRequire(pathToFileURL(fromFile)).resolve.paths(specifier),
    },
  );
  // hermes-parser loads on the first Flow module.
  let hermes: { parse: (text: string, options: object) => unknown } | undefined;
  services.parseFlow = (text) => {
    hermes ??= createRequire(import.meta.url)("hermes-parser") as typeof hermes;
    return hermes!.parse(text, { flow: "all", sourceType: "module", tokens: false }) as FlowNode;
  };
  return services;
}

let shared: FrontendServices | undefined;
/** Standalone Node utilities share a lazy parser whose transport closes at
 * process exit. Compilation loads create and dispose their own services. */
export function nodeFrontendServices(): FrontendServices {
  return (shared ??= createNodeFrontendServices());
}

/** The services of the compile in progress: one build loads the program more
 * than once (the island decision reloads it, and each island retry round
 * loads it again), and services created per load start a cold checker for
 * every one of them. A build opens one scope around its whole frontend work
 * (beginCompileServices) and the loads share it. */
let compileServices: FrontendServices | null = null;
let compileScopes = 0;

/** The services the compile in progress shares, opened for `one` scope. The
 * last scope to end closes them, so nothing outlives a build. */
export function beginCompileServices(): FrontendServices {
  if (compileServices === null) {
    const services = createNodeFrontendServices();
    services.reuseProgramHosts(programHostLoads());
    compileServices = services;
  }
  compileScopes += 1;
  return compileServices;
}

export function endCompileServices(services: FrontendServices): void {
  if (compileScopes > 0) compileScopes -= 1;
  if (compileScopes > 0 || compileServices !== services) return;
  compileServices = null;
  services.close();
}

/** The compile in progress's services, or null outside a compile (a frontend
 * then creates its own). */
export function compileFrontendServices(): FrontendServices | null {
  return compileServices;
}
