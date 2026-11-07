import type { Match } from "../../../locale/types.ts";
import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class Hour0To11Parser extends Parser<number> {
  priority: number;
  parse(dateString: string, token: string, match: Match): ParseResult<number>;
  validate<DateType extends Date>(_date: DateType, value: number): boolean;
  set<DateType extends Date>(
    date: DateType,
    _flags: ParseFlags,
    value: number,
  ): DateType;
  incompatibleTokens: string[];
}
