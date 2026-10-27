import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { FrontendServices } from "./services.js";
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
