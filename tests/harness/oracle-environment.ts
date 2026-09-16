import { createHash } from "node:crypto";

/**
 * The complete inherited environment visible to the Node oracle. Corpus
 * programs may read arbitrary process.env keys directly or through imported
 * modules, so an allowlist cannot soundly describe this input. Keys sort by
 * UTF-16 code unit for a deterministic order; names and values are
 * length-framed so missing, empty, and delimiter-containing entries remain
 * distinct.
 */
export function oracleEnvironmentFingerprint(env: NodeJS.ProcessEnv): string {
  return Object.keys(env)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .map((key) => {
      const value = env[key];
      const framedValue = value === undefined ? "unset" : `${value.length}:${value}`;
      return `${key.length}:${key}:${framedValue};`;
    })
    .join("");
}

interface OracleCacheKeyBaseInputs {
  nodeVersion: string;
  typescriptVersion: string;
  comptimeShim: string;
  islandShim: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}

/** The shared, testable base of every per-program Node oracle cache key. */
export function oracleCacheKeyBase(inputs: OracleCacheKeyBaseInputs): string {
  return createHash("sha256")
    .update("oracle-v3\0")
    .update(inputs.nodeVersion).update("\0")
    .update(inputs.typescriptVersion).update("\0")
    .update(inputs.comptimeShim).update("\0")
    .update(inputs.islandShim).update("\0")
    .update(oracleEnvironmentFingerprint(inputs.environment)).update("\0")
    .update(inputs.cwd).update("\0")
    .digest("hex");
}
