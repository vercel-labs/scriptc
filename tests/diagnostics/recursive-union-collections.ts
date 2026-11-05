// A union that holds a Set of itself, with no record in between, has no
// static layout: the build reports it (SC2009) where the type is used, and
// does not crash.
type Tree = string | Set<Tree>;

export const tree: Tree = "leaf";
