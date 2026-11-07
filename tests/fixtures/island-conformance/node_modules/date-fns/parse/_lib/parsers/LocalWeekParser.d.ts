import type { Match } from "../../../locale/types.ts";
import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult, ParserOptions } from "../types.ts";
export declare class LocalWeekParser extends Parser<number> {
  priority: number;
  parse(dateString: string, token: string, match: Match): ParseResult<number>;
  validate<DateType extends Date>(_date: DateType, value: number): boolean;
  set<DateType extends Date>(
    date: DateType,
    _flags: ParseFlags,
    value: number,
    options: ParserOptions,
  ): DateType;
  incompatibleTokens: string[];
}
