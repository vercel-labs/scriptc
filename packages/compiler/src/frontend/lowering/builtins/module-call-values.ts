import { exactValueParams, type BuiltinModuleFn } from "../surfaces.js";

/** Modules whose call lowering is this file's table tail plus the
 * member-level refinements named in CALL_SHAPE_MEMBERS below. Every other
 * module owns a call dispatcher elsewhere (crypto, zlib, http, stream,
 * timers/promises, util, …), where a row can stand for a shape-specific entry
 * point this file does not see; those members derive no function value and
 * keep the by-name refusal. */
export const DERIVED_VALUE_MODULES: ReadonlySet<string> = new Set([
  "fs",
  "fs/promises",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "punycode",
]);

/** Members of those modules whose call lowering reads the call node itself —
 * the argument count, the static type or literal spelling of an argument, or
 * the shape of an options object — before the table tail. Their row is a
 * dispatch sentinel rather than a function signature, so a derived function
 * value would bypass the validation the call site performs (the utf8-only
 * read, the Dirent option, a descriptor where a path is declared). They keep
 * the by-name refusal unless the row carries an explicit `valueParams`
 * contract. Keep in sync with the branches of lowerBuiltinModuleCall. */
export const CALL_SHAPE_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  fs: new Set([
    "_toUnixTimestamp",
    "accessSync",
    "appendFileSync",
    "copyFileSync",
    "cp",
    "cpSync",
    "createReadStream",
    "createWriteStream",
    "existsSync",
    "ftruncateSync",
    "futimesSync",
    "glob",
    "globSync",
    "gracefulify",
    "linkSync",
    "lstatSync",
    "lutimesSync",
    "mkdirSync",
    "openSync",
    "opendirSync",
    "readFileSync",
    "readSync",
    "readdirSync",
    "readlinkSync",
    "readvSync",
    "realpathSync",
    "rename",
    "rmSync",
    "statSync",
    "statfsSync",
    "symlinkSync",
    "truncateSync",
    "utimesSync",
    "watch",
    "watchFile",
    "writeFileSync",
    "writeSync",
    "writevSync",
  ]),
  "fs/promises": new Set([
    "access",
    "appendFile",
    "copyFile",
    "cp",
    "glob",
    "link",
    "lutimes",
    "mkdir",
    "open",
    "opendir",
    "readFile",
    "readdir",
    "readlink",
    "rm",
    "statfs",
    "symlink",
    "truncate",
    "utimes",
    "writeFile",
  ]),
  os: new Set(["cpus", "getPriority", "networkInterfaces", "setPriority", "userInfo"]),
  path: new Set(["format", "parse"]),
  "path/posix": new Set(["format", "parse"]),
  "path/win32": new Set(["format", "parse"]),
};

/** The function-value contract a table row derives from its own direct-call
 * ABI (wave-2 decision 5 = A). Read as a value in a typed slot, a builtin is
 * a closure whose body is the row's libCall applied to parameters of the
 * row's own types — exactly the lowering a direct call with arguments of
 * those types compiles to, so the slot's signature picks the same entry
 * point the program's own calls do. The closure is interned per row family
 * (`%builtin.value.<fn>`), so every slot it converts into shares one identity
 * root and `value === imported` holds.
 *
 * Row shapes a source-level function type cannot spell, or whose lowering
 * would bypass call-site validation, answer null and keep the by-name
 * refusal: rest packs (`path.join`), omitted-argument defaults,
 * the untyped checked adapter, callback parameters (`fs.read`), and the
 * members in CALL_SHAPE_MEMBERS. `length` is the derived adapter's
 * required-parameter count, the rule the explicit contracts already follow. */
export function derivedBuiltinValueFn(
  bi: { module: string; member: string },
  fn: BuiltinModuleFn,
): BuiltinModuleFn | null {
  if (fn.valueParams || fn.defaults || fn.checked || fn.variadicPack) return null;
  if (fn.fn === "fs.callbackCall") return null;
  if (!DERIVED_VALUE_MODULES.has(bi.module)) return null;
  const shapeValidated =
    Object.hasOwn(CALL_SHAPE_MEMBERS, bi.module) && CALL_SHAPE_MEMBERS[bi.module]!.has(bi.member);
  if (shapeValidated) return null;
  // A dynamic parameter (the checked-dynamic object/array forms) or a
  // callback parameter has no typed slot to lower against.
  if (fn.params.some((param) => param.kind === "dyn" || param.kind === "func")) return null;
  if (fn.result.kind === "dyn") return null;
  return { ...fn, valueParams: exactValueParams(...fn.params) };
}
