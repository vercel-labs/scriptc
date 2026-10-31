/* node:v8 — importable for the packages that require it at top level.
 * getHeapStatistics answers allocator-derived figures in Node's shape
 * (approximate: the runtime heap's total and used bytes, the machine's
 * memory as the limit; V8-only figures are 0). The other members observe
 * V8 itself and fence at their use with the by-design reason; they are
 * declared so programs that type-check under their own tsc reach that
 * fence. */
declare module "v8" {
  type DoesZapCodeSpaceFlag = 0 | 1;
  export interface HeapInfo {
    total_heap_size: number;
    total_heap_size_executable: number;
    total_physical_size: number;
    total_available_size: number;
    used_heap_size: number;
    heap_size_limit: number;
    malloced_memory: number;
    peak_malloced_memory: number;
    does_zap_garbage: DoesZapCodeSpaceFlag;
    number_of_native_contexts: number;
    number_of_detached_contexts: number;
    total_global_handles_size: number;
    used_global_handles_size: number;
    external_memory: number;
  }
  export function getHeapStatistics(): HeapInfo;
  export function cachedDataVersionTag(): number;
  export function getHeapSpaceStatistics(): unknown[];
  export function getHeapCodeStatistics(): unknown;
  export function getHeapSnapshot(options?: unknown): unknown;
  export function writeHeapSnapshot(fileName?: string, options?: unknown): string;
  export function setFlagsFromString(flags: string): void;
  export function setHeapSnapshotNearHeapLimit(limit: number): void;
  export function serialize(value: unknown): Buffer;
  export function deserialize(buffer: Uint8Array): unknown;
  export function takeCoverage(): void;
  export function stopCoverage(): void;
  export function isStringOneByteRepresentation(content: string): boolean;
}

declare module "node:v8" {
  export * from "v8";
}
