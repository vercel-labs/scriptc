// The tsconfig lists "dom" in "lib", which admits the names only that library
// declares (`document` and `HTMLElement` below). A name that no library
// declares keeps its error, and it is the only one reported.
function widthOf(target: HTMLElement): number {
  return target.offsetWidth;
}
console.log(typeof widthOf, typeof document);
console.log(missingWidget);
