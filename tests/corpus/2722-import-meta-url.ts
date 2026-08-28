// import.meta.url: the ESM module URL. Asserts are startsWith/endsWith/
// includes only — the absolute path legitimately differs between the Node
// run directory and the scriptc build directory.
export function getModuleUrl(): string {
  return import.meta.url;
}
console.log(getModuleUrl().startsWith("file://"));
console.log(
  getModuleUrl().endsWith("2722-import-meta-url.ts") ||
    getModuleUrl().endsWith("2722-import-meta-url.js"),
);
console.log(import.meta.url.includes("/"));
