import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class TimestampMillisecondsParser extends Parser<number> {
  priority: number;
  parse(dateString: string): ParseResult<number>;
  set<DateType extends Date>(
    date: DateType,
    _flags: ParseFlags,
    value: number,
  ): [DateType, ParseFlags];
  incompatibleTokens: "*";
}
