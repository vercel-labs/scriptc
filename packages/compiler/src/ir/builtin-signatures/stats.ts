import { BOOL, DATE_T, F64, STATS_T } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The stats builtin call slots. */
export const statsSignatures = defineLibFnSignatures({
  "stats.isFile": { argTypes: [STATS_T], result: BOOL },
  "stats.isDirectory": { argTypes: [STATS_T], result: BOOL },
  "stats.isSymbolicLink": { argTypes: [STATS_T], result: BOOL },
  "stats.size": { argTypes: [STATS_T], result: F64 },
  "stats.dev": { argTypes: [STATS_T], result: F64 },
  "stats.ino": { argTypes: [STATS_T], result: F64 },
  "stats.blocks": { argTypes: [STATS_T], result: F64 },
  "stats.nlink": { argTypes: [STATS_T], result: F64 },
  "stats.atimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.mtimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.ctimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.birthtimeMs": { argTypes: [STATS_T], result: F64 },
  "stats.mode": { argTypes: [STATS_T], result: F64 },
  "stats.uid": { argTypes: [STATS_T], result: F64 },
  "stats.gid": { argTypes: [STATS_T], result: F64 },
  "stats.rdev": { argTypes: [STATS_T], result: F64 },
  "stats.blksize": { argTypes: [STATS_T], result: F64 },
  "stats.isBlockDevice": { argTypes: [STATS_T], result: BOOL },
  "stats.isCharacterDevice": { argTypes: [STATS_T], result: BOOL },
  "stats.isFIFO": { argTypes: [STATS_T], result: BOOL },
  "stats.isSocket": { argTypes: [STATS_T], result: BOOL },
  /** The Date fields: the *Ms value rounded (Node's dateFromMs). */
  "stats.atime": { argTypes: [STATS_T], result: DATE_T },
  "stats.mtime": { argTypes: [STATS_T], result: DATE_T },
  "stats.ctime": { argTypes: [STATS_T], result: DATE_T },
  "stats.birthtime": { argTypes: [STATS_T], result: DATE_T },
});
