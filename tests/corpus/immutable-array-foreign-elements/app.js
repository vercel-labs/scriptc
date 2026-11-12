// Untyped JavaScript whose own code makes a dynamic store possible: a
// keyed write through a value typed `any` can reach a native array as a
// live view, and the program's arrays of that element type are read
// through a checked element read from then on.
export function assign(n, l) {
  for (const u in l) n[u] = l[u];
}
