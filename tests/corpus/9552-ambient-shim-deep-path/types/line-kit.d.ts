// `line-kit/cli` is a subpath export, which `moduleResolution: node` does not read:
// typed as the package types it.
declare module "line-kit/cli" {
  export * from "line-kit/dist/cli.js";
}
