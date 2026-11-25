// The tsconfig's "lib" does not list "dom", so the names only that library
// declares stay errors, with a hint that names the setting.
function widthOf(target: HTMLElement): number {
  return target.offsetWidth;
}
console.log(typeof widthOf, typeof document);
