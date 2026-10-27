import type { DiagnosticCategory } from "./enums.generated.js";
import type { Ts7DiagnosticData } from "./session-schema.generated.js";

/** A diagnostic with every member set, as tsc-ts/api's Diagnostic has them. The server leaves out
 * the members a diagnostic doesn't have. `fileName` is undefined for global and program
 * diagnostics. */
export interface Ts7Diagnostic {
  readonly fileName: string | undefined;
  readonly pos: number;
  readonly end: number;
  readonly code: number;
  readonly category: DiagnosticCategory;
  readonly text: string;
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  readonly messageChain: readonly Ts7Diagnostic[];
  readonly relatedInformation: readonly Ts7Diagnostic[];
}

/** `data` with its absent members set: undefined, false, or no chained or related diagnostics. */
export function ts7Diagnostic(data: Ts7DiagnosticData): Ts7Diagnostic {
  const chain: Ts7Diagnostic[] = [];
  for (const item of data.messageChain ?? []) chain.push(ts7Diagnostic(item));
  const related: Ts7Diagnostic[] = [];
  for (const item of data.relatedInformation ?? []) related.push(ts7Diagnostic(item));
  return {
    fileName: data.fileName,
    pos: data.pos,
    end: data.end,
    code: data.code,
    category: data.category,
    text: data.text,
    reportsUnnecessary: data.reportsUnnecessary ?? false,
    reportsDeprecated: data.reportsDeprecated ?? false,
    messageChain: chain,
    relatedInformation: related,
  };
}
