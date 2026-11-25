import type { Localize } from "../../locale/types.ts";
import type {
  FirstWeekContainsDateOptions,
  LocalizedOptions,
  WeekOptions,
} from "../../types.ts";
type Formatter = (
  date: Date,
  token: string,
  localize: Localize,
  options: Required<
    LocalizedOptions<"options"> & WeekOptions & FirstWeekContainsDateOptions
  >,
) => string;
export declare const formatters: {
  [token: string]: Formatter;
};
export {};
