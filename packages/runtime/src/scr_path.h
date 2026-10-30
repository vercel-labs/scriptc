/* scriptc runtime — node:path (scr_path.c), path globs (scr_glob.c), and
 * module resolution at run time (scr_require.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_PATH_H
#define SCR_PATH_H

#include "scr_array.h"

/* ── node:path (scr_path.c) ──────────────────────────────────────────
 * BOTH of Node's implementations, ported exactly: the scr_path_* family
 * is posix, the scr_path_win32_* family is Node v24's path.win32 (the
 * compiler binds the bare module by TARGET; the path.posix/path.win32
 * namespaces bind their family anywhere). All arguments are BORROWED;
 * every string result is fresh (+1). Nothing throws. join/resolve take
 * the call's variadic arguments packed into ONE string[] (the compiler
 * builds the array literal); the resolves consult getcwd like Node
 * (failure aborts, like process.cwd), the win32 one after the per-drive
 * "=X:" env vars. basename always receives a suffix — "" (a Node no-op)
 * when the call omitted it. */
ScrStr *scr_path_join(ScrArr *parts);
ScrStr *scr_path_resolve(ScrArr *parts);
ScrStr *scr_path_normalize(ScrStr *path);
ScrStr *scr_path_dirname(ScrStr *path);
ScrStr *scr_path_basename(ScrStr *path, ScrStr *suffix);
ScrStr *scr_path_extname(ScrStr *path);
bool scr_path_is_absolute(ScrStr *path);
ScrStr *scr_path_relative(ScrStr *from, ScrStr *to);
/* posix.toNamespacedPath — the identity (Node: "Non-op on posix
 * systems"). +1 via retain. */
ScrStr *scr_path_to_namespaced_path(ScrStr *path);
/* path.win32.* — Node v24's win32 implementation ported exactly
 * (backslash output, both slashes on input, UNC/device/drive-letter
 * roots, the reserved device names, the CVE-2024-36139 normalize
 * hardening); join/resolve keep the packed-string[] ABI. On win32
 * TARGETS these back the bare `path` module (Node on Windows IS
 * path.win32); everywhere they are the path.win32 namespace. resolve
 * consults the per-drive "=X:" env vars then the cwd, like Node's.
 * Same borrow/+1 contract as the posix set; nothing throws. */
ScrStr *scr_path_win32_join(ScrArr *parts);
ScrStr *scr_path_win32_resolve(ScrArr *parts);
ScrStr *scr_path_win32_normalize(ScrStr *path);
ScrStr *scr_path_win32_dirname(ScrStr *path);
ScrStr *scr_path_win32_basename(ScrStr *path, ScrStr *suffix);
ScrStr *scr_path_win32_extname(ScrStr *path);
bool scr_path_win32_is_absolute(ScrStr *path);
ScrStr *scr_path_win32_relative(ScrStr *from, ScrStr *to);
ScrStr *scr_path_win32_to_namespaced_path(ScrStr *path);
/* path.parse / path.format for both families: parse answers a fresh
 * string[] [root, dir, base, ext, name]; format takes the pathObject
 * fields with undefined spelled "" (Node reads each through `||`). */
ScrArr *scr_path_parse(ScrStr *path);
ScrArr *scr_path_win32_parse(ScrStr *path);
ScrStr *scr_path_format(ScrStr *root, ScrStr *dir, ScrStr *base, ScrStr *name, ScrStr *ext);
ScrStr *scr_path_win32_format(ScrStr *root, ScrStr *dir, ScrStr *base, ScrStr *name,
                              ScrStr *ext);
/* ── node:path functions read as values (scr_builtin_values.c) ───────
 * The adapters behind a stored `path.posix.join` or a `path.win32`
 * namespace passed around, whose arguments arrive unchecked: lib/path.js's
 * validateString/validateObject under Node's argument names, then the
 * functions above. All borrow; results are +1, or NULL with Node's
 * ERR_INVALID_ARG_TYPE pending. resolve_value validates `paths[i]` only as
 * far as Node's last-first walk reads them; format_value answers `base`
 * itself when there is no dir (Node's _format), so its result is a dyn
 * value. */
struct ScrDyn;
ScrStr *scr_path_resolve_value(const struct ScrDyn *args, bool win32);
struct ScrDyn *scr_path_parse_value(const struct ScrDyn *path, bool win32);
struct ScrDyn *scr_path_format_value(const struct ScrDyn *object, bool win32);
struct ScrDyn *scr_path_to_namespaced_value(struct ScrDyn *path, bool win32);
/* path.matchesGlob (scr_glob.c): Node 24's minimatch with matchGlobPattern's
 * options, case-insensitive on macOS and Windows hosts like Node. Borrows
 * both; a brace sequence over 2^32 - 1 elements throws Node's RangeError, a
 * pattern over 65536 units its TypeError, and a segment regex invalid under
 * the u flag its SyntaxError. scr_glob_match is the same with the family
 * and case mode explicit (the oracle tests use it). */
bool scr_path_matches_glob(ScrStr *path, ScrStr *pattern);
bool scr_path_win32_matches_glob(ScrStr *path, ScrStr *pattern);
bool scr_glob_match(ScrStr *path, ScrStr *pattern, bool windows, bool nocase);
/* fs.globSync / fs.glob / fs/promises glob (scr_glob.c): Node 24's
 * lib/internal/fs/glob.js walk. The pattern (a string or string array) and
 * options (exclude, cwd, followSymlinks, withFileTypes) arrive as dyn
 * values and are validated in Node's order with Node's errors (borrowed).
 * scr_fs_glob answers the result snapshot (+1, or NULL with the exception
 * pending); mode bit 0 asks for Dirent rows (name, parentPath, UV_DIRENT
 * kind) and must agree with withFileTypes, bit 1 is the fs/promises form,
 * whose Dirents carry resolved parent paths. strings is the string[] form.
 * callback takes fs.glob's argument vector, throws validation errors
 * synchronously and delivers the result or the walk's error through the
 * filesystem callback queue. */
typedef struct ScrDyn ScrDyn; /* full definition in scr_dyn.h (C11 repeat) */
typedef struct ScrFsGlob ScrFsGlob;
ScrFsGlob *scr_fs_glob(const ScrDyn *pattern, const ScrDyn *options, double mode);
size_t scr_fs_glob_count(const ScrFsGlob *g); /* NULL -> 0 */
ScrStr *scr_fs_glob_path(const ScrFsGlob *g, size_t i);   /* +1 */
ScrStr *scr_fs_glob_name(const ScrFsGlob *g, size_t i);   /* +1 */
ScrStr *scr_fs_glob_parent(const ScrFsGlob *g, size_t i); /* +1 */
double scr_fs_glob_type(const ScrFsGlob *g, size_t i);
void scr_fs_glob_free(ScrFsGlob *g); /* NULL-tolerant */
ScrArr *scr_fs_glob_strings(const ScrDyn *pattern, const ScrDyn *options);
void scr_fs_glob_callback(ScrDyn *args);
/* The fs/promises form: a walk error does not throw; the matches found
 * before it are returned and scr_fsp_glob_error answers the error (+1 dyn,
 * undefined when there is none) once, for the loop to throw after them. */
ScrArr *scr_fsp_glob_strings(const ScrDyn *pattern, const ScrDyn *options);
ScrDyn *scr_fsp_glob_error(void);

/* createRequire's require(id) and require.resolve(request, options) with a
 * specifier computed at run time (scr_require.c). Both resolve with Node
 * 24's CommonJS algorithm from `importer`, the requiring file; `builtins`
 * lists the builtin ids (process.getBuiltinModule's table), and `site` is
 * the call's "file:line" for the SC2020 refusal. All arguments are
 * borrowed. scr_require_computed always leaves an exception pending and
 * returns NULL: Node's argument errors, or MODULE_NOT_FOUND when nothing
 * resolves; a specifier that resolves ends the program with the refusal.
 * scr_require_resolve answers the resolved id or real path (+1), or NULL
 * with Node's error pending. */
ScrDyn *scr_require_computed(ScrDyn *id, ScrStr *importer, ScrStr *site, ScrArr *builtins);
ScrStr *scr_require_resolve(ScrDyn *request, ScrDyn *options, ScrStr *importer, ScrStr *site,
                            ScrArr *builtins);

#endif /* SCR_PATH_H */
