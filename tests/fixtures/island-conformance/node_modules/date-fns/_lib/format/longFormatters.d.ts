import type { FormatLong } from "../../locale/types.ts";
type LongFormatter = (pattern: string, formatLong: FormatLong) => string;
export declare const longFormatters: Record<string, LongFormatter>;
export {};
