import type { FormatLongFn, FormatLongWidth } from "../types.ts";
export interface BuildFormatLongFnArgs<
  DefaultMatchWidth extends FormatLongWidth,
> {
  formats: Partial<{
    [format in FormatLongWidth]: string;
  }> & {
    [format in DefaultMatchWidth]: string;
  };
  defaultWidth: DefaultMatchWidth;
}
export declare function buildFormatLongFn<
  DefaultMatchWidth extends FormatLongWidth,
>(args: BuildFormatLongFnArgs<DefaultMatchWidth>): FormatLongFn;
