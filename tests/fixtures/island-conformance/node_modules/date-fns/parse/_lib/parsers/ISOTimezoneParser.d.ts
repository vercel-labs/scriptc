import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class ISOTimezoneParser extends Parser<number> {
  priority: number;
  parse(dateString: string, token: string): ParseResult<number>;
  set<DateType extends Date>(
    date: DateType,
    flags: ParseFlags,
    value: number,
  ): DateType;
  incompatibleTokens: string[];
}
