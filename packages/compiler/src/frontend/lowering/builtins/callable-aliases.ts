import { isIslandPromisifyCall } from "../lower-node-island.js";
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { builtinModuleFnOf } from "../surfaces.js";
import { registerHttpClientFnBinding } from "../lower-server.js";
import { isPromisifiedZlibMember } from "./compression.js";
import { isPromisifiedCryptoMember } from "./crypto.js";
import { isPromisifiedDnsMember } from "../lower-dgram.js";
import { callbackPromisifyShape, untypedPromisifyArgument } from "./promisify-callback.js";

/** Compile-time util.promisify projections. The immutable result binding
 * owns no runtime slot: calls rewrite to the target's promise lowering,
 * while value uses remain explicit fences. Unsupported targets report at
 * the declaration, where their identity is still visible. */
export function isPromisifyCall(lowerer: Lowerer, init: ts.Expression): ts.CallExpression | null {
  let e: ts.Expression = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e) || e.questionDotToken) return null;
  // `promisify(...)` over a named import, `util.promisify(...)` over a
  // namespace or default import.
  const bi = ts.isIdentifier(e.expression)
    ? lowerer.builtinImportOf(e.expression)
    : ts.isPropertyAccessExpression(e.expression)
      ? lowerer.builtinMemberOf(e.expression)
      : null;
  if (!bi || bi.module !== "util" || bi.member !== "promisify") return null;
  // util.promisify of an island function is an island call (NI-5b).
  if (isIslandPromisifyCall(lowerer, e)) return null;
  return e;
}

/** Immutable aliases of table-backed builtin functions. The alias is a
 * compile-time call target, so direct calls keep the builtin's validated
 * lowering without materializing a JavaScript function object. Value
 * uses remain fenced until an escaping closure adapter exists. */
export function registerBuiltinCallableAlias(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || !init) return false;
  let targetExpr = init;
  while (ts.isParenthesizedExpression(targetExpr)) targetExpr = targetExpr.expression;
  if (!ts.isIdentifier(targetExpr)) return false;
  const sourceSymbol = lowerer.resolveValueSymbol(targetExpr);
  const existing = sourceSymbol ? lowerer.staticCallables.get(sourceSymbol) : undefined;
  const target =
    existing?.kind === "builtin-function"
      ? { module: existing.module, member: existing.member }
      : lowerer.builtinImportOf(targetExpr);
  if (!target || !builtinModuleFnOf(lowerer, target.module, target.member)) return false;
  // These checked native functions retain a runtime slot in JavaScript so
  // aliases can escape without narrowing their arguments to string.
  if (
    isJsSourceFile(ts.getSourceFileOfNode(nameNode)) &&
    target.module === "util" &&
    ["stripVTControlCharacters", "toUSVString", "isDeepStrictEqual", "styleText"].includes(
      target.member,
    )
  )
    return false;
  if (lowerer.checker.getCallSignatures(lowerer.typeOf(nameNode)).length === 0) return false;
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (!symbol) return false;
  lowerer.staticCallables.set(symbol, {
    kind: "builtin-function",
    module: target.module,
    member: target.member,
  });
  return true;
}

/** The fs callback functions whose promisified form is the fs/promises
 * member of the same name: the callback's single result is the promise's
 * value and the errors are the same. fs.open (an fd number, where
 * fs/promises.open gives a FileHandle), fs.exists (a custom promisify),
 * and fs.read/fs.write (multi-value callbacks) are not in the set. */
const PROMISIFIED_FS_MEMBERS: ReadonlySet<string> = new Set([
  "access",
  "appendFile",
  "chmod",
  "chown",
  "copyFile",
  "lchown",
  "link",
  "lstat",
  "lutimes",
  "mkdir",
  "mkdtemp",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
]);

/** The global setTimeout/setImmediate as a promisify target, keyed like
 * the node:timers exports they are. Node's util.promisify returns their
 * custom promisified form, which is timers/promises' function of the same
 * name. */
function globalTimerOf(
  lowerer: Lowerer,
  ident: ts.Identifier,
): { module: string; member: string } | null {
  if (ident.text !== "setTimeout" && ident.text !== "setImmediate") return null;
  if (!lowerer.isStdlibSymbol(lowerer.resolveValueSymbol(ident) ?? undefined)) return null;
  return { module: "timers", member: ident.text };
}

export function registerPromisifiedBuiltinDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!init) return false;
  // The OTHER special const-binding form this decl hook serves: the
  // `const requestFn = tls ? https.request : http.request` client
  // ternary (lower-server.ts's registry) — calls through it lower as
  // the runtime-secure http client.
  if (registerHttpClientFnBinding(lowerer, nameNode, init)) return true;
  const e = isPromisifyCall(lowerer, init);
  if (!e) return false;
  const argNode = e.arguments.nodes.length === 1 ? e.arguments.nodes[0]! : null;
  // `promisify(exec)` over a named import, or `promisify(cp.exec)` over a
  // namespace import.
  const target = !argNode
    ? null
    : ts.isIdentifier(argNode)
      ? (lowerer.builtinImportOf(argNode) ?? globalTimerOf(lowerer, argNode))
      : ts.isPropertyAccessExpression(argNode)
        ? lowerer.builtinMemberOf(argNode)
        : null;
  const projection =
    target?.module === "child_process" && target.member === "execFile"
      ? { kind: "promisified-exec-file" as const }
      : target?.module === "child_process" && target.member === "exec"
        ? { kind: "promisified-exec" as const }
        : target?.module === "fs" && PROMISIFIED_FS_MEMBERS.has(target.member)
          ? { kind: "promisified-builtin" as const, module: "fs/promises", member: target.member }
          : target?.module === "timers" &&
              (target.member === "setTimeout" || target.member === "setImmediate")
            ? {
                kind: "promisified-builtin" as const,
                module: "timers/promises",
                member: target.member,
              }
            : target?.module === "stream" &&
                (target.member === "finished" || target.member === "pipeline")
              ? {
                  kind: "promisified-builtin" as const,
                  module: "stream/promises",
                  member: target.member,
                }
              : target?.module === "zlib" && isPromisifiedZlibMember(target.member)
                ? { kind: "promisified-zlib" as const, member: target.member }
                : target?.module === "crypto" && isPromisifiedCryptoMember(target.member)
                  ? { kind: "promisified-crypto" as const, member: target.member }
                  : target?.module === "dns" && isPromisifiedDnsMember(target.member)
                    ? { kind: "promisified-dns" as const, member: target.member }
                    : null;
  // A typed callback-last function value: the call lowers to a native
  // promisified function, and the binding holds it like any closure.
  if (
    !projection &&
    (callbackPromisifyShape(lowerer, e, locOf(e)) !== null || untypedPromisifyArgument(lowerer, e))
  )
    return false;
  if (!projection) {
    lowerer.noLowering(
      "util.promisify of this target",
      argNode ?? e,
      "child_process.exec, child_process.execFile, setTimeout, setImmediate, stream.finished, stream.pipeline, the zlib callback one-shots, the crypto callback functions (randomBytes, pbkdf2, scrypt, hkdf, randomFill, randomInt, generateKey), dns.lookup, dns.lookupService, the fs callback functions with an fs/promises counterpart, and typed callback-last functions whose callback takes (error?: Error | null, value?) are the supported targets",
    );
  }
  const symbol = lowerer.checker.getSymbolAtLocation(nameNode);
  if (symbol) lowerer.staticCallables.set(symbol, projection);
  return true;
}
