// A project-owned declaration file is authored callback surface, unlike
// lib.d.ts/@types/package declarations. The profile's emitChunk channel must
// claim this exact ambient binding when lib_project_dts.ts calls it.
declare function emitChunk(chunk: Uint8Array, seq: number): void;
