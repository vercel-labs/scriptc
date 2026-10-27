import { everyModuleNode, everyStmtList, transformStmtList } from "../ir/traverse.js";
import type { LlvmUnsupportedError } from "./llvm/emitter.js";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { type IrModule, type SrcLoc } from "../ir/ir.js";
import {
  DH_LIB_FNS,
  PKI_LIB_FNS,
  moduleUsesFetch,
  moduleUsesWebCryptoAsymmetric,
} from "../ir/runtime-features.js";

/** Reflection tables expose methods that the program never calls. On WASI,
 * keep their host-only implementations as explicit runtime refusals. Typed
 * calls, escaped callables, constructors, and exported roots still retain
 * the ordinary target diagnostic. ABI types remain checked by the gate. */
export function fenceSpeculativeWasiFunctions(mod: IrModule): void {
  for (const fn of mod.functions)
    fn.body = transformStmtList(fn.body, {
      stmt: (statement) => statement,
      expr: (expr) => {
        if (expr.kind !== "libCall") return expr;
        const portable =
          expr.fn === "fetch.abortControllerNew"
            ? "abort.controllerNew"
            : expr.fn === "fetch.abortTimeout"
              ? "abort.timeout"
              : expr.fn === "fetch.abortNow"
                ? "abort.now"
                : expr.fn === "fetch.abortAny"
                  ? "abort.any"
                  : null;
        return portable ? { ...expr, fn: portable } : expr;
      },
    });
  if (!mod.functions.some((fn) => fn.speculativeDispatch)) return;
  const functions = new Map(mod.functions.map((fn) => [fn.name, fn]));
  const classes = new Map((mod.classes ?? []).map((info) => [info.name, info]));
  const descends = (name: string, base: string): boolean => {
    for (
      let info = classes.get(name);
      info;
      info = info.base ? classes.get(info.base) : undefined
    ) {
      if (info.name === base) return true;
    }
    return false;
  };
  const mandatory = new Set<string>();
  const queue = [mod.entry, ...(mod.lib?.exports.map((entry) => entry.fnName) ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!;
    if (mandatory.has(name)) continue;
    mandatory.add(name);
    const fn = functions.get(name);
    if (!fn || fn.speculativeDispatch) continue;
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr) => {
        if (expr.kind === "call") queue.push(expr.callee);
        if (expr.kind === "closure") queue.push(expr.fnName);
        if (expr.kind === "new") queue.push(`%${expr.className}.constructor`);
        if (expr.kind === "newValue" && expr.callee.type.kind === "classval") {
          const base = expr.callee.type.className;
          for (const info of classes.values())
            if (descends(info.name, base)) queue.push(`%${info.name}.constructor`);
        }
        if (expr.kind === "virtualCall") {
          for (const info of classes.values())
            if (descends(info.name, expr.className)) queue.push(`%${info.name}.${expr.method}`);
        }
        return true;
      },
    });
  }
  for (const fn of mod.functions) {
    if (mandatory.has(fn.name) || fn.speculativeDispatch) continue;
    const unavailable = moduleWasiUnavailableSurface({
      irVersion: mod.irVersion,
      sourceFile: mod.sourceFile,
      functions: [fn],
      classes: [],
      records: [],
      unions: [],
      globals: [],
      entry: fn.name,
    });
    if (!unavailable) continue;
    fn.body = [
      {
        kind: "runtimeFence",
        code: "SC3002",
        message: `wasm32-wasi target does not support ${unavailable.surface}`,
        loc: unavailable.loc,
      },
    ];
    const parameters = new Set(
      [...fn.params, ...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map(
        (param) => param.localId,
      ),
    );
    fn.locals = fn.locals.filter((local) => parameters.has(local.id));
  }
}

/** The LLVM backend's tier refusal as a diagnostic. SC3xxx = backend
 * coverage (the program is fine — this backend doesn't compile it yet);
 * the parenthesized kind tag is machine-readable for the differential
 * harness's histogram. */
export function llvmRefusalDiag(err: LlvmUnsupportedError, entryPath: string): ScrDiagnostic {
  return {
    code: "SC3001",
    message: err.message,
    loc: err.loc ?? { file: entryPath, start: 0, end: 0 },
  };
}

/** A valid program surface that the selected execution target cannot host.
 * SC3xxx stays the backend/target-coverage family: source semantics are
 * valid, but this target deliberately refuses them instead of emitting a
 * binary that traps later. */
export function targetRefusalDiag(target: string, surface: string, loc: SrcLoc): ScrDiagnostic {
  return {
    code: "SC3002",
    message: `${target} target does not support ${surface}`,
    loc,
  };
}

/** node:os and process host facts WASI Preview 1 has no interface for. */
const WASI_UNAVAILABLE_HOST_FACTS: ReadonlyMap<string, string> = new Map([
  ["os.cpusTake", "CPU enumeration (WASI Preview 1 has no processor API)"],
  ["os.hostname", "the host name (WASI Preview 1 has no host-name API)"],
  ["os.freemem", "system memory statistics (WASI Preview 1 has no memory API)"],
  ["os.loadavg", "system load averages (WASI Preview 1 has no load API)"],
  ["os.uptime", "system uptime (WASI Preview 1 has no boot-time API)"],
  ["os.getPriority", "process scheduling priority (WASI Preview 1 has no priority API)"],
  ["os.setPriority", "process scheduling priority (WASI Preview 1 has no priority API)"],
  ["process.memoryUsageTake", "process memory statistics (WASI Preview 1 has no memory API)"],
  ["process.rss", "process memory statistics (WASI Preview 1 has no memory API)"],
  ["process.ppid", "the parent process id (WASI Preview 1 has no process API)"],
]);

export function moduleWasiUnavailableSurface(
  mod: IrModule,
): { surface: string; loc: SrcLoc } | null {
  const entryLoc: SrcLoc = { file: mod.sourceFile, start: 0, end: 0 };
  const prefixes: readonly (readonly [string, string])[] = [
    ["cp.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["child.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes.", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["net.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http.", "network sockets (WASI Preview 1 has no socket API)"],
    ["https.", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["h2.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgram.", "network sockets (WASI Preview 1 has no socket API)"],
    ["dns.", "network sockets (WASI Preview 1 has no socket API)"],
    ["tls.", "network sockets (WASI Preview 1 has no socket API)"],
    ["fetch.", "network-backed fetch (WASI Preview 1 has no socket API)"],
    ["fs.watch", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["watcher.", "filesystem watching (WASI Preview 1 has no notification API)"],
  ];
  const kinds: ReadonlyMap<string, string> = new Map([
    ["child", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["spawnRes", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childStream", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["childWriter", "child processes (WASI Preview 1 has no process-spawning API)"],
    ["netServer", "network sockets (WASI Preview 1 has no socket API)"],
    ["netSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Session", "network sockets (WASI Preview 1 has no socket API)"],
    ["http2Stream", "network sockets (WASI Preview 1 has no socket API)"],
    ["dgramSocket", "network sockets (WASI Preview 1 has no socket API)"],
    ["fsWatcher", "filesystem watching (WASI Preview 1 has no notification API)"],
    ["httpReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpRes", "network sockets (WASI Preview 1 has no socket API)"],
    ["httpClientReq", "network sockets (WASI Preview 1 has no socket API)"],
    ["secureCtx", "network sockets (WASI Preview 1 has no socket API)"],
  ]);
  let found: { surface: string; loc: SrcLoc } | null = null;
  everyModuleNode(mod, {
    type: (node, loc) => {
      const surface = kinds.get(node.kind);
      if (surface === undefined) return true;
      found = { surface, loc };
      return false;
    },
    stmt: () => true,
    expr: (node) => {
      if (node.kind !== "libCall") return true;
      const loc = node.loc;
      if (
        node.fn === "process.kill" ||
        node.fn === "process.killNum" ||
        node.fn === "process.onSignal" ||
        node.fn === "process.offSignal"
      ) {
        found = { surface: "OS signals (WASI Preview 1 has no signal API)", loc };
        return false;
      }
      if (node.fn.startsWith("wasm.")) {
        found = {
          surface:
            "the WebAssembly API (a wasm32-wasi program cannot load translated modules into its own linear memory yet)",
          loc,
        };
        return false;
      }
      if (node.fn === "crypto.cipherNew") {
        found = {
          surface:
            "symmetric ciphers (the wasm32-wasi runtime does not include the mbedTLS library)",
          loc,
        };
        return false;
      }
      if (
        node.fn === "webcrypto.encrypt" ||
        node.fn === "webcrypto.decrypt" ||
        node.fn === "webcrypto.wrapKey" ||
        node.fn === "webcrypto.unwrapKey"
      ) {
        found = {
          surface:
            "WebCrypto encrypt, decrypt, wrapKey and unwrapKey (the wasm32-wasi runtime does not include the mbedTLS library)",
          loc,
        };
        return false;
      }
      if (node.fn === "crypto.ecdhNew" || node.fn === "crypto.ecdhConvertKey") {
        found = {
          surface: "ECDH (the wasm32-wasi runtime does not include the mbedTLS library)",
          loc,
        };
        return false;
      }
      if (DH_LIB_FNS.has(node.fn)) {
        found = {
          surface:
            node.fn === "crypto.dhNew" || node.fn === "crypto.dhGroupNew"
              ? "DiffieHellman (the wasm32-wasi runtime does not include the mbedTLS library)"
              : "checkPrime and generatePrime (the wasm32-wasi runtime does not include the mbedTLS library)",
          loc,
        };
        return false;
      }
      if (PKI_LIB_FNS.has(node.fn)) {
        found = {
          surface:
            "asymmetric keys and signatures (the wasm32-wasi runtime does not include the mbedTLS library)",
          loc,
        };
        return false;
      }
      if (node.fn === "os.networkInterfaces") {
        found = {
          surface: "network-interface enumeration (WASI Preview 1 has no interface API)",
          loc,
        };
        return false;
      }
      const hostFact = WASI_UNAVAILABLE_HOST_FACTS.get(node.fn);
      if (hostFact !== undefined) {
        found = { surface: hostFact, loc };
        return false;
      }
      for (const [prefix, surface] of prefixes) {
        if (node.fn.startsWith(prefix)) {
          found = { surface, loc };
          return false;
        }
      }
      return true;
    },
  });
  if (found !== null) return found;

  if (moduleUsesFetch(mod)) {
    return { surface: "network-backed fetch (WASI Preview 1 has no socket API)", loc: entryLoc };
  }
  if (moduleUsesWebCryptoAsymmetric(mod)) {
    return {
      surface:
        "WebCrypto ECDSA and RSA (the wasm32-wasi runtime does not include the mbedTLS library)",
      loc: entryLoc,
    };
  }
  return null;
}
