/* The overlay's verdicts carried from one build to the next build of the
 * same JavaScript (fallback.ts, pipeline.ts):
 * - the annotations and files whose lowering was refused, so the next
 *   build renders the overlay without them instead of lowering, refusing
 *   and reloading again;
 * - that the build compiled without the overlay, so the next build does
 *   not analyze at all;
 * - the deferred refusals the build without the overlay has, so the next
 *   build need not lower the program without the overlay to compare.
 *
 * A memo is keyed by the compiler, the SCRIPTC_SHAPE_* settings and the
 * text of every JavaScript file of the program; the program's TypeScript
 * files are not part of the key, so editing them keeps the memo. Every
 * verdict only makes the overlay smaller or answers a comparison about
 * the same JavaScript, and a build still runs the fallback on whatever
 * the lowering refuses. The memo directory lives in the build cache, so
 * SCRIPTC_NO_CACHE=1 turns it off; it is never read or written without
 * one. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OverlayMemo {
  /** The build compiled without the overlay. */
  readonly off: boolean;
  /** Refused annotation ids per file, valid for the overlay input text
   * with this hash. */
  readonly annotations: readonly MemoFileIds[];
  /** Files whose whole overlay was refused, by their text as written. */
  readonly files: readonly MemoFile[];
  /** Deferred refusals of the build without the overlay
   * (`code|file|line`). */
  readonly plainFences: readonly string[];
}

export interface MemoFile {
  readonly file: string;
  readonly hash: string;
}

export interface MemoFileIds {
  readonly file: string;
  readonly hash: string;
  readonly ids: readonly number[];
}

let memoDir: string | null = null;

/** Where memos live (a directory of the build cache, per compiler), or
 * null for none. The compile driver sets it per build. */
export function setShapeOverlayMemoDir(dir: string | null): void {
  memoDir = dir;
}

export function shapeOverlayMemoEnabled(): boolean {
  return memoDir !== null;
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The memo key of a program's JavaScript files (name and text) and the
 * shape and inference settings. */
export function overlayMemoKey(files: readonly (readonly [string, string])[]): string {
  const hash = createHash("sha256");
  const settings = Object.keys(process.env)
    .filter(
      (k) =>
        (k.startsWith("SCRIPTC_SHAPE_") && !k.startsWith("SCRIPTC_SHAPE_CHECK")) ||
        k === "SCRIPTC_INFER_JS",
    )
    .sort();
  for (const k of settings)
    hash
      .update(k)
      .update("=")
      .update(process.env[k] ?? "")
      .update("\0");
  const sorted = [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, text] of sorted) hash.update(name).update("\0").update(text).update("\0");
  return hash.digest("hex").slice(0, 40);
}

export function readOverlayMemo(key: string): OverlayMemo | null {
  if (memoDir === null) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(memoDir, `${key}.json`), "utf8"));
    return isOverlayMemo(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeOverlayMemo(key: string, memo: OverlayMemo): void {
  if (memoDir === null) return;
  try {
    mkdirSync(memoDir, { recursive: true, mode: 0o700 });
    const path = join(memoDir, `${key}.json`);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, JSON.stringify(memo), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // The memo only saves work; a build that cannot write it is unaffected.
  }
}

function isOverlayMemo(raw: unknown): raw is OverlayMemo {
  if (raw === null || typeof raw !== "object") return false;
  const m = raw as Record<string, unknown>;
  const files = m["files"];
  const annotations = m["annotations"];
  const plain = m["plainFences"];
  return (
    typeof m["off"] === "boolean" &&
    Array.isArray(files) &&
    files.every(isMemoFile) &&
    Array.isArray(annotations) &&
    annotations.every(
      (a: unknown) =>
        isMemoFile(a) &&
        Array.isArray((a as Record<string, unknown>)["ids"]) &&
        ((a as Record<string, unknown>)["ids"] as unknown[]).every((i) => typeof i === "number"),
    ) &&
    Array.isArray(plain) &&
    plain.every((s: unknown) => typeof s === "string")
  );
}

function isMemoFile(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const f = raw as Record<string, unknown>;
  return typeof f["file"] === "string" && typeof f["hash"] === "string";
}
