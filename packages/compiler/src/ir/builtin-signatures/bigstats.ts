import { BIGINT_T, BIGINT_STATS_T, BOOL, DATE_T } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The bigstats builtin call slots. */
export const bigstatsSignatures = defineLibFnSignatures({
  /** BigIntStats (statSync with `{ bigint: true }`): the same snapshot
   * handle under Node's bigint member table — every number member of Stats
   * (the integers, `*Ms` and the BigIntStats-only `*Ns`) answers `bigint`;
   * only the four time members stay `Date`s. */
  "bigstats.isFile": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isDirectory": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isSymbolicLink": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isBlockDevice": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isCharacterDevice": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isFIFO": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.isSocket": { argTypes: [BIGINT_STATS_T], result: BOOL },
  "bigstats.size": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.dev": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.ino": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.blocks": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.nlink": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.mode": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.uid": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.gid": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.rdev": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.blksize": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.atimeNs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.mtimeNs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.ctimeNs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.birthtimeNs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.atimeMs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.mtimeMs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.ctimeMs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.birthtimeMs": { argTypes: [BIGINT_STATS_T], result: BIGINT_T },
  "bigstats.atime": { argTypes: [BIGINT_STATS_T], result: DATE_T },
  "bigstats.mtime": { argTypes: [BIGINT_STATS_T], result: DATE_T },
  "bigstats.ctime": { argTypes: [BIGINT_STATS_T], result: DATE_T },
  "bigstats.birthtime": { argTypes: [BIGINT_STATS_T], result: DATE_T },
});
