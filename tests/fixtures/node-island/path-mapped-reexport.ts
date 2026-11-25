// Re-exports from an island package that tsconfig `paths` maps to its
// installed directory: the type-only one is erased, the star one reports
// the island boundary (a star re-export names nothing the re-exporting
// module could bind; a named one is supported, corpus 6898), and the
// package's declarations never compile as a program module. The test
// builds it beside corpus 6839's pathkit package.
export type { Route } from "pathkit";
export * from "pathkit";
console.log("loaded");
