import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FfiProfile } from "../ffi/ffi-manifest.js";
import { compilerReleaseVersion } from "../library/sidecar.js";
import {
  EXECUTABLE_RUNTIME_SOURCES,
  executableSectionEliminationFlags,
  runtimeSrcDir,
} from "./native-toolchain.js";
import {
  EXTERNAL_OBJECT_ABI_STABILITY,
  RUNTIME_ABI_MARKER,
  RUNTIME_ABI_VERSION,
} from "./runtime-abi.js";
import type { NativeTargetSpec } from "./targets.js";
import { LRE_SOURCES, QJS_ENGINE_SOURCES } from "./vendor-archives.js";

export interface NativeLinkFeatures {
  dynamic: boolean;
  regex: boolean;
  copying: boolean;
  textDecoderLegacy: boolean;
  fileHandle: boolean;
  fetch: boolean;
  netIsland: boolean;
  zlib: boolean;
  assert: boolean;
  inspect: boolean;
  dynInvoke: boolean;
  dc: boolean;
  dynAsync: boolean;
  events: boolean;
  emitter: boolean;
  symbol: boolean;
  searchParams: boolean;
  qs: boolean;
  parseArgs: boolean;
  stream: boolean;
  net: boolean;
  http: boolean;
  http2: boolean;
  dgram: boolean;
  watch: boolean;
  foreignFfi: boolean;
  nodeTest: boolean;
  tls: boolean;
  tlsCa: boolean;
}

export interface NativeSourceSet {
  name: "runtime" | "libregexp" | "quickjs" | "mbedtls";
  output: "objects" | "archive";
  suggested_output: string;
  sources: string[];
  include_directories: string[];
  defines: string[];
  c_flags: string[];
}

export interface NativeLinkInfo {
  schema: "scriptc.native-link-info.v1";
  format: 1;
  compiler_version: string;
  object_abi: {
    stability: "experimental";
    compatibility: "exact-runtime-version";
  };
  target: {
    name: NativeTargetSpec["name"];
    llvm_triple: NativeTargetSpec["llvmTriple"];
    architecture: NativeTargetSpec["architecture"];
    object_format: NativeTargetSpec["objectFormat"];
    minimum_os: NativeTargetSpec["minimumOs"];
    relocation_model: NativeTargetSpec["relocationModel"];
  };
  program: {
    object: string;
    entry_symbol: "main";
    undefined_runtime_symbol_prefix: "scr_";
  };
  runtime_abi: {
    version: typeof RUNTIME_ABI_VERSION;
    marker: typeof RUNTIME_ABI_MARKER;
  };
  runtime_pack: {
    kind: "source";
    package: "@scriptc/runtime";
    version: string;
    root: string;
    path_base: "runtime_pack.root";
    source_sets: NativeSourceSet[];
  };
  ffi: {
    format: number | null;
    symbols: string[];
    libraries: string[];
  };
  link: {
    input_order: string[];
    driver_flags: string[];
    system_libraries: string[];
    frameworks: string[];
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function packagePath(...parts: string[]): string {
  return parts.join("/");
}

function runtimeSourceRecipe(
  features: NativeLinkFeatures,
  target: NativeTargetSpec,
  env: NodeJS.ProcessEnv,
  optimization: "release" | "dev",
): { sets: NativeSourceSet[]; systemLibraries: string[]; driverFlags: string[] } {
  const dynamic = features.dynamic;
  const executableSectionFlags = executableSectionEliminationFlags(target.platform);
  const curlFetch = dynamic && features.fetch && env["SCRIPTC_FETCH_CURL"] === "1";
  const nativeFetch = features.fetch && !curlFetch;
  const netIsland = dynamic && (features.netIsland || nativeFetch);
  const net = features.net || nativeFetch || netIsland;
  const http = features.http || nativeFetch || netIsland;
  const tls = features.tls || nativeFetch || netIsland;
  const tlsCa = features.tlsCa || tls;
  const wasiUnavailableSources = new Set([
    "scr_child.c", "scr_dyn_handle.c", "scr_loop_kqueue.c", "scr_loop_epoll.c",
    "scr_loop_wsapoll.c", "scr_net.c", "scr_http.c", "scr_http2.c", "scr_dgram.c",
    "scr_watch.c", "scr_tls_ca.c", "scr_tls.c", "scr_fetch.c", "scr_net_island.c",
  ]);
  const runtimeSources = [
    ...EXECUTABLE_RUNTIME_SOURCES.filter((source) =>
      target.platform !== "wasi" || !wasiUnavailableSources.has(source)
    ),
    ...(target.platform === "win32" ? ["scr_win.c"] : []),
    ...(target.name === "linux-x64-musl" || target.name === "linux-arm64-musl"
      ? ["scr_musl.c"]
      : []),
    ...(features.copying ? ["scr_copying.c"] : []),
    ...(features.fileHandle ? ["scr_file_handle.c"] : []),
    ...(features.regex ? ["scr_regex.c"] : []),
    ...(features.assert || features.regex || features.symbol ? ["scr_assert.c"] : []),
    ...(features.inspect ? ["scr_inspect.c"] : []),
    ...(features.dynInvoke || nativeFetch ? ["scr_dyn_invoke.c"] : []),
    ...(features.dc ? ["scr_dc.c"] : []),
    ...(features.dynAsync || features.dynInvoke || features.dc || nativeFetch
      ? ["scr_async_dyn.c"]
      : []),
    ...(features.zlib ? ["scr_zlib.c"] : []),
    ...(features.zlib && dynamic ? ["scr_zlib_island.c"] : []),
    ...(features.events ? ["scr_events.c", "scr_readline.c"] : []),
    ...(features.emitter ? ["scr_events_emitter.c"] : []),
    ...(features.emitter || net ? ["scr_dyn_handle.c"] : []),
    ...(features.symbol ? ["scr_symbol.c"] : []),
    ...(features.searchParams ? ["scr_url_params.c"] : []),
    ...(features.qs ? ["scr_qs.c"] : []),
    ...(features.parseArgs ? ["scr_util.c"] : []),
    ...(features.stream ? ["scr_stream.c"] : []),
    ...(net || features.dgram
      ? ["scr_loop_kqueue.c", "scr_loop_epoll.c", "scr_loop_wsapoll.c"]
      : []),
    ...(net ? ["scr_net.c"] : []),
    ...(http ? ["scr_http.c"] : []),
    ...(features.http2 ? ["scr_http2.c"] : []),
    ...(features.dgram ? ["scr_dgram.c"] : []),
    ...(features.watch ? ["scr_watch.c"] : []),
    ...(features.foreignFfi ? ["scr_ffi_queue.c"] : []),
    ...(features.nodeTest ? ["scr_test.c"] : []),
    ...(tlsCa ? ["scr_tls_ca.c"] : []),
    ...(tls ? ["scr_tls.c"] : []),
    ...(nativeFetch ? ["scr_fetch.c"] : []),
    ...(dynamic
      ? [
          "scr_island.c",
          "scr_web.c",
          ...(features.inspect ? ["scr_inspect_island.c"] : []),
          ...(netIsland ? ["scr_net_island.c"] : []),
          ...(curlFetch ? ["scr_fetch_curl.c"] : []),
        ]
      : []),
  ];
  const filteredSources = target.platform === "wasi"
    ? runtimeSources.filter((source) => !wasiUnavailableSources.has(source))
    : runtimeSources;
  const sets: NativeSourceSet[] = [{
    name: "runtime",
    output: "objects",
    suggested_output: "runtime/*.o",
    sources: unique(filteredSources).map((source) => packagePath("src", source)),
    include_directories: unique([
      "src",
      ...(features.regex || dynamic ? ["vendor/quickjs-ng"] : []),
      ...(tls ? ["vendor/mbedtls/include"] : []),
      ...(curlFetch ? ["vendor/curl/include"] : []),
    ]),
    defines: unique([
      ...target.runtimeCompileDefines,
      ...(features.textDecoderLegacy ? ["SCR_TEXT_DECODER_LEGACY"] : []),
      ...(dynamic ? ["SCR_DYNAMIC"] : []),
    ]),
    c_flags: [
      "-std=c11", "-target", target.llvmTriple,
      ...(target.platform === "win32" || target.platform === "wasi" ? [] : ["-pthread"]),
      optimization === "dev" ? "-O0" : "-O2",
      ...executableSectionFlags.compile,
      "-fno-math-errno", "-fno-strict-aliasing", "-Wno-deprecated-declarations",
    ],
  }];
  if (features.regex && !dynamic) {
    sets.push({
      name: "libregexp",
      output: "archive",
      suggested_output: "libscriptc-regexp.a",
      sources: LRE_SOURCES.map((source) => packagePath("vendor", "quickjs-ng", source)),
      include_directories: ["vendor/quickjs-ng"],
      defines: [],
      c_flags: [
        "-std=c11", "-target", target.llvmTriple,
        ...target.runtimeCompileDefines.map((define) => `-D${define}`),
        "-Os",
      ],
    });
  }
  if (dynamic) {
    sets.push({
      name: "quickjs",
      output: "archive",
      suggested_output: "libscriptc-quickjs.a",
      sources: QJS_ENGINE_SOURCES.map((source) => packagePath("vendor", "quickjs-ng", source)),
      include_directories: ["vendor/quickjs-ng"],
      defines: ["QUICKJS_NG_BUILD", "_GNU_SOURCE", "NDEBUG"],
      c_flags: [
        "-std=gnu11", "-target", target.llvmTriple,
        ...target.runtimeCompileDefines.map((define) => `-D${define}`),
        "-fvisibility=hidden",
        "-funsigned-char", "-Os",
      ],
    });
  }
  // mbedTLS is the one source set whose membership is intentionally the
  // package's complete library/*.c set. The package version and ABI marker
  // pin those bytes as one exact runtime pack.
  if (tls) {
    sets.push({
      name: "mbedtls",
      output: "archive",
      suggested_output: "libscriptc-mbedtls.a",
      sources: [],
      include_directories: ["vendor/mbedtls/include", "vendor/mbedtls/library"],
      defines: [],
      c_flags: [
        "-std=c11", "-target", target.llvmTriple,
        ...target.runtimeCompileDefines.map((define) => `-D${define}`),
        "-Os",
      ],
    });
  }
  if (target.platform === "wasi") {
    const blocked = features.net || features.http || features.http2 || features.dgram ||
      features.watch || features.tls || features.tlsCa || features.fetch || features.netIsland;
    if (blocked) throw new Error("WASI native link info requested an unavailable network/TLS runtime surface");
  }
  const systemLibraries = unique([
    ...target.runtimeSystemLibraries,
    ...((features.zlib || nativeFetch) && target.platform !== "win32" ? ["z"] : []),
    ...(dynamic && target.platform !== "win32" ? ["m"] : []),
    ...(curlFetch ? ["curl"] : []),
  ]);
  return {
    sets,
    systemLibraries,
    driverFlags: [
      ...target.executableLinkerArgs,
    ],
  };
}

export async function createNativeLinkInfo(options: {
  programObject: string;
  target: NativeTargetSpec;
  features: NativeLinkFeatures;
  ffi: FfiProfile | null;
  optimization?: "release" | "dev";
  env?: NodeJS.ProcessEnv;
}): Promise<NativeLinkInfo> {
  const root = dirname(runtimeSrcDir());
  const runtimeVersion = (JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as { version: string }).version;
  const recipe = runtimeSourceRecipe(
    options.features,
    options.target,
    options.env ?? process.env,
    options.optimization ?? "release",
  );
  const mbedtls = recipe.sets.find((set) => set.name === "mbedtls");
  if (mbedtls !== undefined) {
    mbedtls.sources = (await readdir(join(root, "vendor", "mbedtls", "library")))
      .filter((name) => !name.startsWith(".") && name.endsWith(".c"))
      .sort()
      .map((name) => packagePath("vendor", "mbedtls", "library", name));
  }
  const ffiLibraries = options.ffi?.libraries ?? [];
  const vendorInputs = recipe.sets
    .filter((set) => set.output === "archive")
    .map((set) => set.suggested_output);
  return {
    schema: "scriptc.native-link-info.v1",
    format: 1,
    compiler_version: compilerReleaseVersion(),
    object_abi: {
      stability: EXTERNAL_OBJECT_ABI_STABILITY,
      compatibility: "exact-runtime-version",
    },
    target: {
      name: options.target.name,
      llvm_triple: options.target.llvmTriple,
      architecture: options.target.architecture,
      object_format: options.target.objectFormat,
      minimum_os: options.target.minimumOs,
      relocation_model: options.target.relocationModel,
    },
    program: {
      object: options.programObject,
      entry_symbol: "main",
      undefined_runtime_symbol_prefix: "scr_",
    },
    runtime_abi: {
      version: RUNTIME_ABI_VERSION,
      marker: RUNTIME_ABI_MARKER,
    },
    runtime_pack: {
      kind: "source",
      package: "@scriptc/runtime",
      version: runtimeVersion,
      root,
      path_base: "runtime_pack.root",
      source_sets: recipe.sets,
    },
    ffi: {
      format: options.ffi?.ffiFormat ?? null,
      symbols: options.ffi?.functions.map((fn) => fn.symbol) ?? [],
      libraries: [...ffiLibraries],
    },
    link: {
      input_order: [
        options.programObject,
        ...ffiLibraries,
        "runtime/*.o",
        ...vendorInputs,
        "system_libraries",
      ],
      driver_flags: recipe.driverFlags,
      system_libraries: unique([
        ...(options.ffi?.systemLibraries ?? []),
        ...recipe.systemLibraries,
      ]),
      frameworks: [],
    },
  };
}
