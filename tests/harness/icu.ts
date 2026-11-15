/** Whether this machine's runtime pack can link ICU, which answers Intl's
 * number and date formatters (the corpus's `// @requires-icu` programs and
 * the npm-static pilots whose package bundles an Intl call). The packs build
 * ICU only for the Linux x64 target in this slice, and the compiler refuses
 * every Intl-answered form elsewhere with SC3002, so the tests that need it
 * skip where it is absent instead of failing on the documented limitation. */
export function icuAvailable(): boolean {
  return process.platform === "linux" && process.arch === "x64";
}
