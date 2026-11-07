/* Path classification shared by the --npm-static fs shadow and the ambient
 * module projection: which installed package a node_modules path belongs to. */

/** The installed package directory a node_modules path belongs to, or null
 * outside node_modules. */
export function nodeModulesPackageDir(path: string): string | null {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx === -1) return null;
  const parts = norm.slice(idx + "/node_modules/".length).split("/");
  const first = parts[0] ?? "";
  const dirName = first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
  return `${norm.slice(0, idx)}/node_modules/${dirName}`;
}
