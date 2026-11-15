import type { LocaleDayPeriod, Match } from "../../../locale/types.ts";
import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class DayPeriodParser extends Parser<LocaleDayPeriod> {
  priority: number;
  parse(
    dateString: string,
    token: string,
    match: Match,
  ): ParseResult<LocaleDayPeriod>;
  set<DateType extends Date>(
    date: DateType,
    _flags: ParseFlags,
    value: LocaleDayPeriod,
  ): DateType;
  incompatibleTokens: string[];
}
