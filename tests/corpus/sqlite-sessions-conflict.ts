// node:sqlite applyChangeset's onConflict answer: a non-int32 value is the
// database's own misuse error (the apply aborts with SQLITE_MISUSE rather
// than silently answering false), a thrown value keeps its own error, and
// the destination keeps reporting its later errors either way.
import { DatabaseSync } from "node:sqlite";

function fixture(): { dst: DatabaseSync; changeset: Uint8Array } {
  const src = new DatabaseSync(":memory:");
  src.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
  src.exec("INSERT INTO t VALUES (1, 'x')");
  const dst = new DatabaseSync(":memory:");
  dst.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
  dst.exec("INSERT INTO t VALUES (1, 'y')");
  const session = src.createSession();
  src.exec("UPDATE t SET b = 'z' WHERE a = 1");
  const changeset = session.changeset();
  session.close();
  src.close();
  return { dst, changeset };
}

function misuse(label: string, answer: unknown): void {
  const { dst, changeset } = fixture();
  const options: any = { onConflict: () => answer };
  try {
    dst.applyChangeset(changeset, options);
    console.log(label, "-> applied");
  } catch (error) {
    const e = error as {
      name: string;
      message: string;
      code: string;
      errcode?: number;
      errstr?: string;
    };
    console.log(
      label,
      "->",
      e.name,
      e.code,
      e.errcode,
      "errstr" in e ? e.errstr : "none",
      e.message,
    );
  }
  try {
    dst.exec("SELECT * FROM missing");
  } catch (error) {
    const e = error as { code: string; message: string };
    console.log(label, "next:", e.code, e.message);
  }
  console.log(label, "rows:", JSON.stringify(dst.prepare("SELECT a, b FROM t").all()));
  dst.close();
}

misuse("undefined", undefined);
misuse("true", true);
misuse("fraction", 1.5);
misuse("string", "2");
misuse("large", 2 ** 40);
misuse("nan", NaN);
misuse("invalid-code", 4);

const thrown = fixture();
try {
  thrown.dst.applyChangeset(thrown.changeset, {
    onConflict: () => {
      throw new RangeError("stop");
    },
  });
} catch (error) {
  const e = error as { name: string; message: string; code?: string };
  console.log("throw:", e.name, e.message);
}
console.log("throw rows:", JSON.stringify(thrown.dst.prepare("SELECT a, b FROM t").all()));
try {
  thrown.dst.exec("SELECT * FROM missing");
} catch (error) {
  const e = error as { code: string };
  console.log("throw next:", e.code);
}
thrown.dst.close();

const filtered = fixture();
try {
  filtered.dst.applyChangeset(filtered.changeset, {
    filter: () => {
      throw new RangeError("filt");
    },
  });
} catch (error) {
  const e = error as { name: string; message: string };
  console.log("filter:", e.name, e.message);
}
console.log("filter rows:", JSON.stringify(filtered.dst.prepare("SELECT a, b FROM t").all()));
try {
  filtered.dst.exec("SELECT * FROM missing");
} catch (error) {
  const e = error as { code: string };
  console.log("filter next:", e.code);
}
filtered.dst.close();
