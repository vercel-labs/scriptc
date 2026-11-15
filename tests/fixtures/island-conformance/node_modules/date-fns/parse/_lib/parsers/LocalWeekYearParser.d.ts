import type { Match } from "../../../locale/types.ts";
import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult, ParserOptions } from "../types.ts";
import type { YearParserValue } from "./YearParser.ts";
export declare class LocalWeekYearParser extends Parser<YearParserValue> {
  priority: number;
  parse(
    dateString: string,
    token: string,
    match: Match,
  ): ParseResult<YearParserValue>;
  validate<DateType extends Date>(
    _date: DateType,
    value: YearParserValue,
  ): boolean;
  set<DateType extends Date>(
    date: DateType,
    flags: ParseFlags,
    value: YearParserValue,
    options: ParserOptions,
  ): DateType;
  incompatibleTokens: string[];
}
