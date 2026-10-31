declare module "node:module" {
  export function createRequire(filename: string | URL): ScriptcRequire;
  export const builtinModules: string[];
  export function isBuiltin(moduleName: string): boolean;
  export function syncBuiltinESMExports(): void;
}

declare module "module" {
  export * from "node:module";
}
