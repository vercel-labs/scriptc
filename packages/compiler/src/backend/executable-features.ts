/** Runtime requirements derived from the lowered program, shared by compiler hosts. */
import { type IrModule } from "../ir/ir.js";
import {
  moduleEmbedsBuiltin,
  moduleEmbedsCompressedNpm,
  moduleRuntimeFeatures,
} from "../ir/runtime-features.js";
import { hasForeignFfiCallback } from "./ffi-callbacks.js";
import type { NativeLinkFeatures } from "./native-link-info.js";

export function executableLinkFeatures(mod: IrModule, dynamic: boolean): NativeLinkFeatures {
  const features = moduleRuntimeFeatures(mod);
  return {
    ...(mod.workers ? { workers: true } : {}),
    dynamic,
    regex: features.regex,
    copying: features.copying,
    textDecoderLegacy: features.legacyTextDecoder,
    fileHandle: features.fileHandle,
    fetch: features.fetch,
    netIsland:
      moduleEmbedsBuiltin(mod, "node:http") ||
      moduleEmbedsBuiltin(mod, "node:https") ||
      moduleEmbedsBuiltin(mod, "node:net") ||
      moduleEmbedsBuiltin(mod, "node:tls"),
    zlib: features.zlib || moduleEmbedsCompressedNpm(mod),
    assert: features.assert,
    inspect: features.inspect,
    dynInvoke: features.dynInvoke,
    dc: features.dc,
    dynAsync: features.dynAsync,
    events: features.processEvents,
    emitter: features.emitter,
    symbol: features.symbol,
    bigint: features.bigint,
    searchParams: features.searchParams,
    qs: features.qs,
    parseArgs: features.parseArgs,
    stream: features.stream,
    net: features.net,
    http: features.http,
    http2: features.http2,
    dgram: features.dgram,
    watch: features.fsWatch,
    foreignFfi: hasForeignFfiCallback(mod.ffiImports ?? []),
    nodeTest: features.nodeTest,
    tls: features.tls,
    tlsCa: features.tlsCa,
  };
}
