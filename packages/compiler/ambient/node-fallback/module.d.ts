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
  export function findPackageJSON(specifier: string | URL, base?: string | URL): string | undefined;
  export interface SourceMapsSupport {
    enabled: boolean;
    nodeModules: boolean;
    generatedCode: boolean;
  }
  export function getSourceMapsSupport(): SourceMapsSupport;
  export function findSourceMap(path: string): SourceMap | undefined;
  export interface SetSourceMapsSupportOptions {
    nodeModules?: boolean | undefined;
    generatedCode?: boolean | undefined;
  }
  export function setSourceMapsSupport(
    enabled: boolean,
    options?: SetSourceMapsSupportOptions,
  ): void;
  export interface SourceMapConstructorOptions {
    lineLengths?: readonly number[] | undefined;
  }
  export interface SourceMapPayload {
    file: string;
    version: number;
    sources: string[];
    sourcesContent: string[];
    names: string[];
    mappings: string;
    sourceRoot: string;
  }
  export interface SourceMapping {
    generatedLine: number;
    generatedColumn: number;
    originalSource: string;
    originalLine: number;
    originalColumn: number;
  }
  export interface SourceOrigin {
    name: string | undefined;
    fileName: string;
    lineNumber: number;
    columnNumber: number;
  }
  export class SourceMap {
    constructor(payload: SourceMapPayload, options?: SourceMapConstructorOptions);
    readonly payload: SourceMapPayload;
    findEntry(lineOffset: number, columnOffset: number): SourceMapping | {};
    findOrigin(lineNumber: number, columnNumber: number): SourceOrigin | {};
  }
}

declare module "module" {
  export * from "node:module";
}
