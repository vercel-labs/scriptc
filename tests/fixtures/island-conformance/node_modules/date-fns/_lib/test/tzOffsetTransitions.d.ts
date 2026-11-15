interface PartialInterval {
  start: Date | undefined;
  end: Date | undefined;
}
/**
 * Fetch the start and end of DST for the local time
 * zone in a given year.
 * We'll assume that DST start & end are the first
 * forward and the last back transitions in the year,
 * except transitions in Jan or Dec which are likely
 * to be permanent TZ changes rather than DST changes.
 * @param year
 * @returns object with two Date-valued properties:
 * - `start` is the first instant of DST in the Spring,
 *   or undefined if there's no DST in this year.
 * - `end` is the first instant of standard time
 *   in the Fall, or undefined if there's no DST in
 *   this year.
 */
export declare function getDstTransitions(year: number): PartialInterval;
/**
 * Fetch all timezone-offset transitions in a given
 * year.  These are almost always DST transitions,
 * but sometimes there are non-DST changes, e.g.
 * when a country changes its time zone
 * @param year
 * @returns array of objects, each  with the following
 * propeerties:
 * - `date` - a `Date` representing the first instant
 *   when the new timezone offset is effective.
 * - `type` - either `forward` for skippnig time like
 *   the Spring transition to DST.
 * - `before` - the timezone offset before the transition.
 *   For example, the UTC-0400 offset will return -240.
 *   To match how times are displayed in ISO 8601 format,
 *   the sign of this value is reversed from the return
 *   value of `Date.getTimezoneOffset`.
 * - `after` - the timezone offset after the transition.
 *   Examples and caveats are the same as `before`.

 */
export declare function getTzOffsetTransitions(year: number): {
  date: Date;
  type: string;
  before: number;
  after: number;
}[];
export {};
