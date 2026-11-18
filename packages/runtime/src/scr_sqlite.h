/* scriptc runtime — node:sqlite (scr_sqlite.c) over the SQLite amalgamation
 * in packages/runtime/vendor/sqlite.
 *
 * `DatabaseSync`, `StatementSync` and the statement iterator are native
 * checked-dynamic handles: their types map to dyn in the compiler, their
 * methods and getters dispatch through the handle, and the entry points
 * below are the ones a dyn value cannot answer by itself (construction,
 * instanceof, and the module-level backup). Every entry point borrows its
 * arguments and answers +1, or NULL with the exception pending. */
#ifndef SCR_SQLITE_H
#define SCR_SQLITE_H

#include "scr_dyn.h"

/* The handle classes this unit models, for `v instanceof C`: 0
 * DatabaseSync, 1 StatementSync, 2 the statement iterator. */
bool scr_sqlite_is(const struct ScrDyn *value, double kind);

/* new DatabaseSync(path[, options]); the connection opens unless
 * options.open is false. +1 or NULL with the exception pending. */
struct ScrDyn *scr_sqlite_db_new(struct ScrDyn *path, struct ScrDyn *options);

/* sqlite.backup(sourceDb, path[, options]): copy the database to a new
 * file and answer the promise of its page count. +1 or NULL with the
 * exception pending. */
struct ScrDyn *scr_sqlite_backup(struct ScrDyn *source, struct ScrDyn *path,
                                 struct ScrDyn *options);

#endif
