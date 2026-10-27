/* Path confinement for the split tools. A branch they rewrite can commit
 * symlinks, so every file a tool reads or writes goes through a guard for
 * the directory it belongs to (the checkout being rewritten, or the
 * config's directory). The guard resolves the path's real location, through
 * every symlink on the way, and throws when that location is outside the
 * directory's real path. A path that doesn't exist yet resolves through its
 * nearest existing parent, so a write can't create a file through a
 * symlinked directory or a dangling symlink either. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** The real location of `path`, which need not exist: the real path of its
 * nearest existing entry joined with the rest. A dangling symlink resolves
 * to where its target would be. */
function realLocation(path, hops = 0) {
  const rest = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    let stat = null;
    try {
      stat = lstatSync(at);
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
    }
    if (stat) {
      try {
        return join(realpathSync(at), ...rest);
      } catch (e) {
        if (e.code !== "ENOENT" || !stat.isSymbolicLink() || hops > 40) throw e;
        return realLocation(join(resolve(dirname(at), readlinkSync(at)), ...rest), hops + 1);
      }
    }
    if (dirname(at) === at) return resolve(path);
    rest.unshift(basename(at));
  }
}

/** A guard for the files under `root`. */
export function confine(root) {
  const lexical = resolve(root);
  const real = realpathSync(lexical);
  const check = (path) => {
    const location = realLocation(path);
    if (!isInside(real, location))
      throw new Error(`refusing ${path}: it resolves to ${location}, outside ${real}`);
    return location;
  };
  return {
    /** The path's real location; throws when it is outside the root. */
    check,
    /** True when `path` names a file under the root (before symlinks). */
    contains: (path) => isInside(lexical, resolve(path)) || isInside(real, resolve(path)),
    read: (path) => readFileSync(check(path), "utf8"),
    write: (path, text) => writeFileSync(check(path), text),
    exists: (path) => existsSync(check(path)),
    mkdir: (path) => mkdirSync(check(path), { recursive: true }),
    list: (path) => readdirSync(check(path)),
  };
}

/** Routes a TypeScript host's (or `ts.sys`-like object's) file reads under
 * the guard's root through the guard; other files (the TypeScript libraries)
 * read as before. */
export function confineHost(host, guard) {
  const checked =
    (read) =>
    (fileName, ...rest) => {
      if (guard.contains(fileName)) guard.check(fileName);
      return read.call(host, fileName, ...rest);
    };
  return {
    ...host,
    ...(host.getSourceFile ? { getSourceFile: checked(host.getSourceFile) } : {}),
    readFile: checked(host.readFile),
  };
}
