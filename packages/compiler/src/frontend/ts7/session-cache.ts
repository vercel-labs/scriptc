import type { SourceFile } from "./ast-types.js";
import type { Ts7SnapshotChangeData as Ts7SnapshotChanges } from "./session-schema.generated.js";
export type { Ts7SnapshotChangeData as Ts7SnapshotChanges } from "./session-schema.generated.js";

interface CachedSource {
  file: SourceFile;
  parseOptions: string;
  hash: string;
  references: Set<string>;
}

function reference(snapshot: number, project: string): string {
  return `${snapshot}:${project}`;
}

class ProjectPaths {
  readonly paths = new Set<string>();
}
class SnapshotPaths {
  readonly projects = new Map<string, ProjectPaths>();
}

/** AST identity is shared only when path, parser options and content all
 * agree. A server snapshot/project pair owns each reference; project-local
 * invalidation must not evict a version retained by another open snapshot. */
export class Ts7SourceCache {
  private readonly files = new Map<string, CachedSource[]>();
  private readonly paths = new Map<number, SnapshotPaths>();

  get(path: string, snapshot: number, project: string): SourceFile | undefined {
    const ref = reference(snapshot, project);
    return this.files.get(path)?.find((entry) => entry.references.has(ref))?.file;
  }

  set(path: string, file: SourceFile, snapshot: number, project: string): SourceFile {
    let entries = this.files.get(path);
    if (entries === undefined) {
      entries = [];
      this.files.set(path, entries);
    }
    const ref = reference(snapshot, project);
    const parseOptions = file.file.wire.parseOptionsKey;
    const hash = file.file.wire.contentHash;
    const existing = entries.find(
      (entry) => entry.parseOptions === parseOptions && entry.hash === hash,
    );
    if (existing !== undefined) {
      existing.references.add(ref);
      this.track(snapshot, project, path);
      return existing.file;
    }
    entries.push({ file, parseOptions, hash, references: new Set<string>([ref]) });
    this.track(snapshot, project, path);
    return file;
  }

  /** Carry the paths a project kept across a snapshot into the new one.
   * `changes` is the server's change record (absent when nothing changed);
   * `reparsed` names the projects whose parse options changed, whose trees
   * the record does not enumerate and therefore cannot be retained. */
  retain(
    snapshot: number,
    previous: number,
    changes?: Ts7SnapshotChanges,
    reparsed?: ReadonlySet<string>,
  ): void {
    const projects = this.paths.get(previous);
    if (projects === undefined) return;
    for (const [project, retained] of projects.projects) {
      if (changes?.removedProjects?.includes(project)) continue;
      if (reparsed?.has(project)) continue;
      const changed = changes?.changedProjects?.[project];
      const previousRef = reference(previous, project);
      const nextRef = reference(snapshot, project);
      for (const path of retained.paths) {
        if (changed?.changedFiles?.includes(path) || changed?.deletedFiles?.includes(path))
          continue;
        for (const entry of this.files.get(path) ?? []) {
          if (!entry.references.has(previousRef)) continue;
          entry.references.add(nextRef);
          this.track(snapshot, project, path);
        }
      }
    }
  }

  release(snapshot: number): void {
    const projects = this.paths.get(snapshot);
    if (projects === undefined) return;
    for (const [project, retained] of projects.projects) {
      const ref = reference(snapshot, project);
      for (const path of retained.paths) {
        const entries = this.files.get(path);
        if (entries === undefined) continue;
        for (let index = entries.length - 1; index >= 0; index--) {
          const entry = entries[index]!;
          entry.references.delete(ref);
          if (entry.references.size === 0) entries.splice(index, 1);
        }
        if (entries.length === 0) this.files.delete(path);
      }
    }
    this.paths.delete(snapshot);
  }

  private track(snapshot: number, project: string, path: string): void {
    let projects = this.paths.get(snapshot);
    if (projects === undefined) {
      projects = new SnapshotPaths();
      this.paths.set(snapshot, projects);
    }
    let paths = projects.projects.get(project);
    if (paths === undefined) {
      paths = new ProjectPaths();
      projects.projects.set(project, paths);
    }
    paths.paths.add(path);
  }

  clear(): void {
    this.files.clear();
    this.paths.clear();
  }
  get size(): number {
    return this.files.size;
  }
}
