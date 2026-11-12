// @scriptc/experimental — the Node.js load hook.
//
// `node --require @scriptc/experimental/register app.ts` (or `--import`)
// installs Node 24's synchronous module hooks before the entry loads. The
// resolve hook refuses what a scriptc build refuses before it starts: the
// builtin modules the compiler's tables mark out of scope, with the
// compiler's own SC1010 text, and native addons, with nativeAddonDiag's
// SC2020 text. A builtin read through process.getBuiltinModule runs no hook,
// so that function is wrapped with the same module check.
//
// The refused modules come from ./refusals.json: the schemaVersion-1 file
// whose `layer: "load"` rows name them. Only those rows are indexed here;
// the file's other rows belong to the compiler and to run-time checks.
//
// The hooks are installed before this file reads any module, because a
// module Node has already cached skips the load hook. process.getBuiltinModule
// is the one module access that runs no hook, so it acquires node:module and
// node:fs without loading anything the hooks would miss.

const nodeModule = process.getBuiltinModule("node:module");
if (typeof nodeModule.registerHooks !== "function") {
  throw new Error(
    "scriptc: @scriptc/experimental/register needs Node.js 24 or newer, for module.registerHooks",
  );
}

/** The refused builtin modules, by canonical bare name (without `node:`). */
const refusedModules = new Map();

/** An error carrying the diagnostic code a scriptc build would report. */
function refusal(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The canonical bare name of a builtin specifier, or null for anything
 * Node does not serve as a builtin. Bare `test` and `sea` are Node's only
 * prefix-only builtins, so they never match. */
function builtinName(specifier) {
  if (typeof specifier !== "string" || !nodeModule.isBuiltin(specifier)) return null;
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/** The file URL without its query and fragment. */
function fileUrl(url) {
  return url.split(/[?#]/, 1)[0];
}

function resolve(specifier, context, nextResolve) {
  const name = builtinName(specifier);
  if (name !== null) {
    const row = refusedModules.get(name);
    if (row !== undefined) throw refusal(row.code, row.message);
  }
  const resolved = nextResolve(specifier, context);
  if (typeof resolved?.url === "string" && fileUrl(resolved.url).endsWith(".node")) {
    throw refusal(
      "SC2020",
      `native addon '${specifier}' requires Node's addon runtime, which is unavailable in scriptc`,
    );
  }
  return resolved;
}

// The load hook runs after resolve for the formats Node loads itself. It
// refuses nothing on its own: every refusal the resolve hook can decide is
// decided there, including the CommonJS addon require that reaches resolve
// but never load. Keeping it registered leaves the loaded source available
// to the checks that follow in later releases.
function load(url, context, nextLoad) {
  return nextLoad(url, context);
}

nodeModule.registerHooks({ resolve, load });

const refusalsFile = new URL("./refusals.json", import.meta.url);
let refusals;
try {
  refusals = JSON.parse(process.getBuiltinModule("node:fs").readFileSync(refusalsFile, "utf8"));
} catch (error) {
  throw new Error(
    `scriptc: could not read the refusal data ${refusalsFile.pathname}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (refusals?.schemaVersion !== 1) {
  throw new Error(
    `scriptc: the refusal data ${refusalsFile.pathname} has schemaVersion ${refusals?.schemaVersion}; this release reads schemaVersion 1`,
  );
}
if (!Array.isArray(refusals.refusals)) {
  throw new Error(
    `scriptc: the refusal data ${refusalsFile.pathname} has no refusals list; reinstall @scriptc/experimental`,
  );
}

for (const row of refusals.refusals) {
  if (row.layer !== "load" || row.binding?.access !== "import") continue;
  const module = row.binding.module;
  if (typeof module !== "string" || typeof row.code !== "string") continue;
  const name = module.startsWith("node:") ? module.slice(5) : module;
  if (!refusedModules.has(name)) refusedModules.set(name, row);
}

/** The pinned release the refusal data describes; this process may be a
 * different one, whose API set differs. */
if (typeof refusals.nodeVersion === "string") {
  const pinned = `v${refusals.nodeVersion.replace(/^v/, "")}`;
  if (process.version !== pinned) {
    process.stderr.write(
      `scriptc: Node.js ${process.version} differs from ${pinned}, the release this refusal data describes; a module that release refused may be missing from these checks\n`,
    );
  }
}

/** scriptc answers eval, Function and the function constructors the way
 * `--disallow-code-generation-from-strings` does. A preload cannot set the
 * flag for the running context, so warn when the command line lacks it. */
const codeGenerationFlag = "--disallow-code-generation-from-strings";
const execArgs = process.execArgv;
const nodeOptions = (process.env["NODE_OPTIONS"] ?? "").split(/\s+/);
if (!execArgs.includes(codeGenerationFlag) && !nodeOptions.includes(codeGenerationFlag)) {
  process.stderr.write(
    `scriptc: ${codeGenerationFlag} is not set; add it to NODE_OPTIONS so eval, Function and the function constructors fail under Node the way they do in a scriptc binary\n`,
  );
}

/** process.getBuiltinModule bypasses both hook kinds, so it applies the
 * same module check. The message is the one the runtime raises for a
 * builtin a compiled program cannot serve through this call. */
const getBuiltinModule = process.getBuiltinModule;
process.getBuiltinModule = function getBuiltinModuleChecked(id) {
  if (typeof id === "string") {
    const name = id.startsWith("node:") ? id.slice(5) : id;
    if (refusedModules.has(name)) {
      throw refusal(
        "SC2020",
        `native builtin '${name}' is not supported through process.getBuiltinModule yet [SC2020]`,
      );
    }
  }
  return getBuiltinModule.call(process, id);
};
