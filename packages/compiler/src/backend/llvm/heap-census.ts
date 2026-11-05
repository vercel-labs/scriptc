/* The heap census. A program built with SCRIPTC_HEAP_CENSUS set counts, for
 * ranking representation work:
 * - the instances of each class that `new` or a class value constructs,
 *   with the class's size;
 * - for each array-typed class field, its stores (with the stored array's
 *   length in buckets and the total of those lengths), the stores whose
 *   value is an array literal written at the store, and its accesses;
 * - for each record-typed class field, its stores and accesses.
 * Accesses count every field address the backend computes for the field,
 * so a store is also an access. At exit the program writes one
 * tab-separated line per counter to the file the run's SCRIPTC_HEAP_CENSUS
 * names, or to stderr. Linux only: the runtime calls the writer through a
 * weak reference, as it does the profile writer. Counters are module
 * globals updated with monotonic atomic adds, so they include every
 * thread's work. Ordinary builds emit none of it. */
import type { IrClassDef, IrExpr, IrModule, IrType } from "../../ir/ir.js";
import { classStructSym } from "./classes.js";
import { llvmBytes, wtf8Bytes } from "../literals.js";
import type { NullableUnions } from "./nullable-unions.js";

/** Whether this build counts the heap census: SCRIPTC_HEAP_CENSUS is set
 * and nonempty. The executable cache keys on it. */
export function heapCensusRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env["SCRIPTC_HEAP_CENSUS"];
  return flag !== undefined && flag !== "";
}

/** The census of the module being built, or null when it is off. */
export function heapCensusOf(mod: IrModule, unions: NullableUnions): HeapCensus | null {
  if (!heapCensusRequested() || mod.lib !== undefined) return null;
  return new HeapCensus(mod, unions);
}

/** A NUL-terminated i8 array constant of `text`. */
function cString(text: string): string {
  const bytes = wtf8Bytes(text);
  return `[${bytes.length + 1} x i8] c"${llvmBytes(bytes)}"`;
}

const LENGTH_BUCKETS = ["len0", "len1", "len2", "len3-4", "len5-8", "len9-16", "len17+"];
/** Upper bounds of LENGTH_BUCKETS but the last. */
const BUCKET_LIMITS = [0, 1, 2, 4, 8, 16];

interface FieldCounters {
  /** First counter: stores, accesses, then (arrays) the literal stores,
   * the length total and the buckets. */
  base: number;
  array: boolean;
  /** The stored value is a pointer that is NULL for the union's unit arm. */
  nullable: boolean;
}

export class HeapCensus {
  private readonly names: string[] = [];
  private readonly sizes: (string | null)[] = [];
  private readonly instances = new Map<string, number>();
  private readonly fields = new Map<string, FieldCounters>();

  constructor(mod: IrModule, unions: NullableUnions) {
    for (const cls of mod.classes ?? []) {
      this.instances.set(cls.name, this.add(`new\t${cls.name}\t`, classStructSym(cls.name)));
      for (const field of cls.fields) this.addField(cls, field.name, field.type, unions);
    }
  }

  /** Counts one instance of `className`. */
  countNew(line: (text: string) => void, className: string): void {
    for (const text of this.newLines(className)) line(text);
  }

  /** The lines that count one instance of `className`: a `new`, or a
   * construct thunk for class values (`newValue`). */
  newLines(className: string): string[] {
    const index = this.instances.get(className);
    return index === undefined ? [] : [this.increment(index, "1")];
  }

  /** Counts an access of a field; true when the field is counted. */
  countAccess(line: (text: string) => void, className: string, field: string): void {
    const counters = this.fields.get(`${className}\0${field}`);
    if (counters !== undefined) line(this.increment(counters.base + 1, "1"));
  }

  /** Counts a store of `value` (an LLVM pointer, computed from `source`)
   * into a field: its length when the field holds arrays. `tmp` names fresh
   * temporaries. */
  countStore(
    line: (text: string) => void,
    tmp: () => string,
    className: string,
    field: string,
    source: IrExpr,
    value: string | null,
  ): void {
    const counters = this.fields.get(`${className}\0${field}`);
    if (counters === undefined) return;
    line(this.increment(counters.base, "1"));
    if (!counters.array) return;
    const literal = source.kind === "unionWrap" ? source.value : source;
    if (literal.kind === "arrayLit") line(this.increment(counters.base + 2, "1"));
    if (value === null) return;
    // A NULL pointer (the unit arm) counts as length 0: its length is read
    // through a select that points NULL at a zeroed array header.
    let array = value;
    if (counters.nullable) {
      const isNull = tmp();
      array = tmp();
      line(`${isNull} = icmp eq ptr ${value}, null`);
      line(`${array} = select i1 ${isNull}, ptr @sc_census_zero_arr, ptr ${value}`);
    }
    const lenPtr = tmp(),
      len32 = tmp(),
      len = tmp();
    line(`${lenPtr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 1`);
    line(`${len32} = load i32, ptr ${lenPtr}`);
    line(`${len} = zext i32 ${len32} to i64`);
    line(this.increment(counters.base + 3, len));
    // The bucket: the number of limits below the length.
    let bucket = "0";
    for (const limit of BUCKET_LIMITS) {
      const above = tmp(),
        step = tmp(),
        next = tmp();
      line(`${above} = icmp ugt i64 ${len}, ${limit}`);
      line(`${step} = zext i1 ${above} to i64`);
      line(`${next} = add i64 ${bucket}, ${step}`);
      bucket = next;
    }
    const slot = tmp();
    line(`${slot} = add i64 ${bucket}, ${counters.base + 4}`);
    const ptr = tmp();
    line(
      `${ptr} = getelementptr inbounds [${this.names.length} x i64], ptr @sc_census, i64 0, i64 ${slot}`,
    );
    line(`atomicrmw add ptr ${ptr}, i64 1 monotonic`);
  }

  /** The module definitions: the counters, their names, the zero array
   * header NULL stores read their length from, and the writer the runtime
   * calls at exit (scr_census_write). */
  definitions(): string[] {
    const n = this.names.length;
    const out = [`@sc_census = internal global [${n} x i64] zeroinitializer`];
    // A zeroed %ScrArr: length 0.
    out.push(`@sc_census_zero_arr = internal constant %ScrArr zeroinitializer`);
    const names = this.names.map((name, i) => {
      const bytes = cString(name);
      out.push(`@sc_census_name.${i} = private unnamed_addr constant ${bytes}`);
      return `ptr @sc_census_name.${i}`;
    });
    out.push(`@sc_census_names = internal constant [${n} x ptr] [${names.join(", ")}]`);
    const sizes = this.sizes.map((sym) =>
      sym === null ? "i64 0" : `i64 ptrtoint (ptr getelementptr (%${sym}, ptr null, i32 1) to i64)`,
    );
    out.push(`@sc_census_sizes = internal constant [${n} x i64] [${sizes.join(", ")}]`);
    const env = cString("SCRIPTC_HEAP_CENSUS");
    out.push(`@sc_census_env = private unnamed_addr constant ${env}`);
    out.push(`@sc_census_mode = private unnamed_addr constant ${cString("w")}`);
    out.push(`@sc_census_fmt = private unnamed_addr constant ${cString("%s\t%llu\t%llu\n")}`);
    out.push(
      `define void @scr_census_write() {`,
      `entry:`,
      `  %path = call ptr @getenv(ptr @sc_census_env)`,
      `  %named = icmp ne ptr %path, null`,
      `  br i1 %named, label %open, label %err`,
      `open:`,
      `  %file = call ptr @fopen(ptr %path, ptr @sc_census_mode)`,
      `  %opened = icmp ne ptr %file, null`,
      `  br i1 %opened, label %write, label %err`,
      `err:`,
      `  %stderr = load ptr, ptr @stderr`,
      `  br label %write`,
      `write:`,
      `  %out = phi ptr [ %file, %open ], [ %stderr, %err ]`,
      `  br label %loop`,
      `loop:`,
      `  %i = phi i64 [ 0, %write ], [ %next, %loop ]`,
      `  %namep = getelementptr inbounds [${n} x ptr], ptr @sc_census_names, i64 0, i64 %i`,
      `  %name = load ptr, ptr %namep`,
      `  %countp = getelementptr inbounds [${n} x i64], ptr @sc_census, i64 0, i64 %i`,
      `  %count = load atomic i64, ptr %countp monotonic, align 8`,
      `  %sizep = getelementptr inbounds [${n} x i64], ptr @sc_census_sizes, i64 0, i64 %i`,
      `  %size = load i64, ptr %sizep`,
      `  %bytes = mul i64 %count, %size`,
      `  call i32 (ptr, ptr, ...) @fprintf(ptr %out, ptr @sc_census_fmt, ptr %name, i64 %count, i64 %bytes)`,
      `  %next = add i64 %i, 1`,
      `  %done = icmp eq i64 %next, ${n}`,
      `  br i1 %done, label %end, label %loop`,
      `end:`,
      `  call i32 @fflush(ptr %out)`,
      `  ret void`,
      `}`,
    );
    return out;
  }

  /** External declarations the writer uses. */
  declarations(): string[] {
    return [
      "declare ptr @getenv(ptr)",
      "declare ptr @fopen(ptr, ptr)",
      "declare i32 @fprintf(ptr, ptr, ...)",
      "declare i32 @fflush(ptr)",
      "@stderr = external global ptr",
    ];
  }

  private add(name: string, sizeSym: string | null = null): number {
    this.names.push(name);
    this.sizes.push(sizeSym);
    return this.names.length - 1;
  }

  private addField(cls: IrClassDef, field: string, type: IrType, unions: NullableUnions): void {
    let array = type.kind === "array";
    let nullable = false;
    let record = type.kind === "record";
    if (type.kind === "union") {
      const single = unions.single(type.unionId);
      if (single !== null && single.nullTag < 0) {
        array = single.arm.kind === "array";
        record = single.arm.kind === "record";
        nullable = true;
      }
    }
    if (!array && !record) return;
    const key = `${cls.name}\t${field}`;
    const base = this.add(`store\t${key}`);
    this.add(`access\t${key}`);
    if (array) {
      this.add(`literal\t${key}`);
      this.add(`elements\t${key}`);
      for (const bucket of LENGTH_BUCKETS) this.add(`${bucket}\t${key}`);
    }
    this.fields.set(`${cls.name}\0${field}`, { base, array, nullable });
  }

  private increment(index: number, by: string): string {
    return `atomicrmw add ptr getelementptr inbounds ([${this.names.length} x i64], ptr @sc_census, i64 0, i64 ${index}), i64 ${by} monotonic`;
  }
}
