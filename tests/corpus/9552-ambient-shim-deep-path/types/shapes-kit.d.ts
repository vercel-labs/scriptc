// `shapes-kit/cli` is a subpath export, which `moduleResolution: node` does not read:
// typed as the package types it.
declare module "shapes-kit/cli" {
  export * from "shapes-kit/dist/cli.mjs";
}
