import type { Match } from "../../../locale/types.ts";
import type { Era } from "../../../types.ts";
import { Parser } from "../Parser.ts";
import type { ParseFlags, ParseResult } from "../types.ts";
export declare class EraParser extends Parser<number> {
  priority: number;
  parse(dateString: string, token: string, match: Match): ParseResult<Era>;
  set<DateType extends Date>(
    date: DateType,
    flags: ParseFlags,
    value: number,
  ): DateType;
  incompatibleTokens: string[];
}
