// node:sqlite's constants object: the SQLite result, authorizer and changeset
// codes Node exposes, baked as literals at each read (the zlib.constants
// precedent).
import { constants } from "node:sqlite";

console.log(constants.SQLITE_OK, constants.SQLITE_DENY, constants.SQLITE_IGNORE);
console.log(
  constants.SQLITE_CHANGESET_OMIT,
  constants.SQLITE_CHANGESET_REPLACE,
  constants.SQLITE_CHANGESET_ABORT,
);
console.log(
  constants.SQLITE_CHANGESET_DATA,
  constants.SQLITE_CHANGESET_NOTFOUND,
  constants.SQLITE_CHANGESET_CONFLICT,
  constants.SQLITE_CHANGESET_CONSTRAINT,
  constants.SQLITE_CHANGESET_FOREIGN_KEY,
);
console.log(constants.SQLITE_CREATE_TABLE, constants.SQLITE_INSERT, constants.SQLITE_RECURSIVE);
console.log(constants.SQLITE_COPY, constants.SQLITE_SAVEPOINT, constants.SQLITE_FUNCTION);
