import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class ExtendedYearParser extends Parser<number> {
  priority: number;
  parse(dateString: string, token: string): ParseResult<number>;
  set<DateType extends Date>(
    date: DateType,
    _flags: ParseFlags,
    value: number,
  ): DateType;
  incompatibleTokens: string[];
}
