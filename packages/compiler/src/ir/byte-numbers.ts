import type { IrExpr } from "./ir.js";
import type { IntegerRange } from "./integer-ranges.js";

/** Numeric widths are properties of the standard byte operation, not of
 * ordinary number values. Offsets and values retain their JS contracts. */
export interface ByteNumberFormat {
  width: number;
  signed: boolean;
  floating: boolean;
}

export interface ByteNumberAccess extends ByteNumberFormat {
  dataView: boolean;
  write: boolean;
  offsetArg: number;
  valueArg: number;
  littleEndian: boolean;
  endianArg: number;
}

const FORMATS: Readonly<Record<string, ByteNumberFormat | undefined>> = {
  u8: { width: 1, signed: false, floating: false },
  i8: { width: 1, signed: true, floating: false },
  u16: { width: 2, signed: false, floating: false },
  i16: { width: 2, signed: true, floating: false },
  u32: { width: 4, signed: false, floating: false },
  i32: { width: 4, signed: true, floating: false },
  f16: { width: 2, signed: false, floating: true },
  f32: { width: 4, signed: false, floating: true },
  f64: { width: 8, signed: false, floating: true },
  u64: { width: 8, signed: false, floating: false },
  i64: { width: 8, signed: true, floating: false },
};

const VIEW_FORMATS: Readonly<Record<string, string | undefined>> = {
  dvGetUint8: "u8",
  dvGetInt8: "i8",
  dvGetUint16: "u16",
  dvGetInt16: "i16",
  dvGetUint32: "u32",
  dvGetInt32: "i32",
  dvGetFloat16: "f16",
  dvGetFloat32: "f32",
  dvGetFloat64: "f64",
  dvGetBigUint64Number: "u64",
  dvGetBigInt64Number: "i64",
  dvSetUint8: "u8",
  dvSetInt8: "i8",
  dvSetUint16: "u16",
  dvSetInt16: "i16",
  dvSetUint32: "u32",
  dvSetInt32: "i32",
  dvSetFloat16: "f16",
  dvSetFloat32: "f32",
  dvSetFloat64: "f64",
};

function bufferFormat(token: string): ByteNumberFormat | null {
  const kind = token.length === 2 ? token : token.slice(0, -2);
  if (!Object.hasOwn(FORMATS, kind) || kind === "u64" || kind === "i64") return null;
  const format = FORMATS[kind]!;
  return format.width === 1
    ? token === kind
      ? format
      : null
    : token === kind + "le" || token === kind + "be"
      ? format
      : null;
}

export function validByteNumberToken(method: string, token: string): boolean {
  return method === "readNum" || method === "writeNum"
    ? bufferFormat(token) !== null
    : (method === "readNumVar" || method === "writeNumVar") &&
        ["ule", "ube", "ile", "ibe"].includes(token);
}

export function byteNumberAccess(e: IrExpr): ByteNumberAccess | null {
  if (e.kind !== "bytesIntrinsic") return null;
  if (e.method === "readNum" || e.method === "writeNum") {
    const token = e.args[0];
    if (token?.kind !== "strLit") return null;
    const format = bufferFormat(token.value);
    if (!format) return null;
    const write = e.method === "writeNum";
    return {
      ...format,
      dataView: false,
      write,
      offsetArg: write ? 2 : 1,
      valueArg: 1,
      littleEndian: token.value.endsWith("le"),
      endianArg: -1,
    };
  }
  if (e.method === "readNumVar" || e.method === "writeNumVar") {
    const token = e.args[0],
      write = e.method === "writeNumVar";
    const width = e.args[write ? 3 : 2];
    if (
      token?.kind !== "strLit" ||
      !validByteNumberToken(e.method, token.value) ||
      width?.kind !== "numLit" ||
      !Number.isInteger(width.value) ||
      width.value < 1 ||
      width.value > 6
    )
      return null;
    return {
      width: width.value,
      signed: token.value.startsWith("i"),
      floating: false,
      dataView: false,
      write,
      offsetArg: write ? 2 : 1,
      valueArg: 1,
      littleEndian: token.value.endsWith("le"),
      endianArg: -1,
    };
  }
  if (!Object.hasOwn(VIEW_FORMATS, e.method)) return null;
  const format = FORMATS[VIEW_FORMATS[e.method]!]!,
    write = e.method.startsWith("dvSet");
  return {
    ...format,
    dataView: true,
    write,
    offsetArg: 0,
    valueArg: 1,
    littleEndian: false,
    endianArg: format.width === 1 ? -1 : write ? 2 : 1,
  };
}

export function byteNumberRange(format: ByteNumberFormat): IntegerRange | null {
  if (format.floating || format.width > 6) return null;
  const bits = format.width * 8;
  return format.signed
    ? { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 }
    : { min: 0, max: 2 ** bits - 1 };
}
