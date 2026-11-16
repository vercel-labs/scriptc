// A native module that reaches the island module by its workspace package's
// bare subpath (pi's cache-warmer.ts:10 shape): the exported function must
// bind to the island's own export, not be compiled natively.
import { getProbeEnvValue, loadCount } from "@probe/ai/utils/provider-env";

export function warmCache(): string {
  const value = getProbeEnvValue();
  return `${value} (loads ${loadCount()})`;
}
