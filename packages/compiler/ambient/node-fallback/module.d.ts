declare module "node:module" {
  export function createRequire(filename: string | URL): ScriptcRequire;
  export const builtinModules: string[];
  export function isBuiltin(moduleName: string): boolean;
  export function syncBuiltinESMExports(): void;
  export namespace constants {
    namespace compileCacheStatus {
      const FAILED: number;
      const ENABLED: number;
      const ALREADY_ENABLED: number;
      const DISABLED: number;
    }
  }
  export interface EnableCompileCacheResult {
    status: number;
    message?: string;
    directory?: string;
  }
  export interface EnableCompileCacheOptions {
    directory?: string | undefined;
    portable?: boolean | undefined;
  }
  export function enableCompileCache(
    options?: string | EnableCompileCacheOptions,
  ): EnableCompileCacheResult;
  export function flushCompileCache(): void;
  export function getCompileCacheDir(): string | undefined;
}

declare module "module" {
  export * from "node:module";
}
