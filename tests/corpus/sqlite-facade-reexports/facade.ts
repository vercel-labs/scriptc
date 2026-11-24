// The renamed re-exports a facade namespace exposes to the program. Neither
// name is the builtin's own, so reading the access's spelling cannot find
// node:sqlite here.
export { DatabaseSync as DB, backup as snapshotBackup } from "node:sqlite";
