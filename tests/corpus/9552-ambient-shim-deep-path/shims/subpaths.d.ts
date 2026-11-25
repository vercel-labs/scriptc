// Each block stands for a subpath its package maps in `exports`, and gives
// it the declarations of a file the map does not list. The build has to
// read that file by its path, as this project's tsc does.
declare module "spice-rack/blends" {
  export * from "spice-rack/lib/blends.mjs";
}
declare module "stock-pot/timers" {
  export { simmer, stages } from "stock-pot/src/timers.js";
}
