/* node:trace_events — the tracing objects' bookkeeping. A compiled binary
 * carries no trace-event agent (trace output needs the CLI flags and the
 * agent, which a standalone executable has no path to), so a program sees
 * what Node run without the --trace-event-* flags shows: the categories a
 * Tracing object holds, its enabled flag and the enabled-categories list.
 * Tracing values are native handles the runtime builds (type-mapper.ts maps
 * Tracing to the checked-dynamic value), so their member reads and the
 * enable()/disable() calls ride the checked-dynamic tree. */
declare module "trace_events" {
  export interface TracingOptions {
    categories: string[];
    name?: string | undefined;
  }
  export interface Tracing {
    readonly categories: string;
    readonly enabled: boolean;
    enable(): void;
    disable(): void;
  }
  export function createTracing(options: TracingOptions): Tracing;
  export function getEnabledCategories(): string | undefined;
}

declare module "node:trace_events" {
  export * from "trace_events";
}
