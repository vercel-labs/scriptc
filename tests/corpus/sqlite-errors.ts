// node:sqlite's error shapes: the argument checks (a TypeError carrying
// ERR_INVALID_ARG_TYPE/ERR_INVALID_ARG_VALUE), the SQLite failures (an Error
// carrying ERR_SQLITE_ERROR with errcode and errstr), the state failures after
// close, and the SQL-free prepare.
import { DatabaseSync } from "node:sqlite";

const show = (label: string, fn: () => unknown): void => {
  try {
    console.log(label, "ok", fn());
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
      e.name,
      JSON.stringify(e.message),
      e.code,
      e.errcode,
      JSON.stringify(e.errstr),
    );
  }
};

const db = new DatabaseSync(":memory:");
show("exec-num", () => db.exec(1 as unknown as string));
show("prepare-num", () => db.prepare(1 as unknown as string));
show("empty-sql", () => db.prepare("-- nothing"));
show("timeout", () => new DatabaseSync(":memory:", { timeout: 1.5 }));
show("path", () => new DatabaseSync(1 as unknown as string));
show("location-nope", () => db.location("nope"));
db.exec("ATTACH ':memory:' AS aux");
show("location-aux", () => db.location("aux"));
show("syntax", () => db.exec("SELEC 1"));
show("no-column", () => db.prepare("SELECT missing").get());

const statement = db.prepare("SELECT 1 AS one");
statement.close();
show("st-close", () => statement.close());
show("st-get", () => statement.get());
show("st-sql", () => statement.sourceSQL);
show("st-set", () => statement.setReadBigInts(true));
show("setbool", () => db.prepare("SELECT 1").setReadBigInts(1 as unknown as boolean));
db.close();
show("db-close", () => db.close());
show("db-exec", () => db.exec("SELECT 1"));
show("db-istx", () => db.isTransaction);

const closed = new DatabaseSync(":memory:", { open: false });
show("not-open-prep", () => closed.prepare("SELECT 1"));
show("o-isopen", () => closed.isOpen);
closed.open();
show("reopen", () => closed.open());
show("o-exec", () => closed.exec("SELECT 1"));
closed.close();
