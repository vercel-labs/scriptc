import { buildCacheRoot, prepareBuildCacheRoot } from "./build-cache.js";
import { loadRuntimePack } from "./runtime-pack.js";
import { nativeCodegenTarget, nativeCodegenTargetRefusal } from "./targets.js";
import {
  warmNativeCaches as warmDevelopmentRuntime,
  type NativeCacheWarmProfile,
  type WarmNativeCachesOptions,
  type WarmNativeCachesResult,
} from "./native/cache-warm.js";

/** Verify and read the installed runtime families before the first build. */
export async function warmNativeCaches(
  options: WarmNativeCachesOptions = {},
): Promise<WarmNativeCachesResult> {
  if (options.sanitize) return warmDevelopmentRuntime(options);
  const cacheRoot = await prepareBuildCacheRoot(buildCacheRoot());
  if (cacheRoot === null) throw new Error("the native build cache is disabled or unavailable");
  const known = new Set<NativeCacheWarmProfile>(["runtime", "tls"]);
  for (const profile of options.profiles ?? [])
    if (!known.has(profile)) throw new Error(`unknown native cache warm profile '${profile}'`);
  const target = nativeCodegenTarget();
  if (target === null)
    throw new Error(nativeCodegenTargetRefusal() ?? "unsupported runtime-pack target");
  if (!target.supports.exe)
    throw new Error(
      `native cache warming requires an executable target; ${target.name} supports library archives`,
    );
  const profiles = [...new Set(options.profiles ?? (["runtime", "tls"] as const))];
  const results = [];
  for (const profile of profiles) {
    const started = performance.now();
    await loadRuntimePack({
      target,
      optimization: options.optimization ?? "release",
      features: {
        fetch: profile === "tls",
        regex: false,
        copying: false,
        textDecoderLegacy: false,
        fileHandle: false,
        zlib: false,
        assert: false,
        inspect: false,
        dynInvoke: false,
        dc: false,
        dynAsync: false,
        events: false,
        emitter: false,
        symbol: false,
        bigint: false,
        searchParams: false,
        qs: false,
        utilPromisify: false,
        dynBuiltinClass: false,
        dynBuiltinStream: false,
        parseArgs: false,
        stream: false,
        net: false,
        http: false,
        http2: false,
        dgram: false,
        dnsPromises: false,
        dgramDyn: false,
        textCodecDyn: false,
        watch: false,
        foreignFfi: false,
        nodeTest: false,
        tls: false,
        cipher: false,
        ecdh: false,
        dh: false,
        pki: false,
        ed25519: false,
        x509: false,
        webcrypto: false,
        perfLoop: false,
        tlsCa: false,
      },
    });
    results.push({ profile, elapsedMs: Math.round((performance.now() - started) * 10) / 10 });
  }
  return { cacheRoot, profiles: results };
}
