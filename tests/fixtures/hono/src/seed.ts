/* Deterministic seed data: a seeded PRNG builds the same catalogue,
 * membership and loan history on every run. */

import { FORMATS, GENRES, type BookDraft, type Genre, type MemberTier } from "./domain.ts";
import type { LibraryService } from "./service.ts";

export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]!);
    return out;
  }
}

const ADJECTIVES = ["Silent", "Hidden", "Last", "Bright", "Broken", "Golden", "Distant", "Northern", "Quiet", "Hollow", "Endless", "Paper", "Iron", "Small", "Wild", "Secret"];
const NOUNS = ["Garden", "River", "Atlas", "Lantern", "Harbor", "Orchard", "Machine", "Library", "Mountain", "Archive", "Compass", "Island", "Theory", "Kingdom", "Signal", "Winter"];
const FIRST = ["Ada", "Ben", "Clara", "Dmitri", "Elena", "Farid", "Grace", "Hiro", "Ines", "Jonas", "Kemi", "Lars", "Mira", "Noor", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tara"];
const LAST = ["Okafor", "Lindqvist", "Moreau", "Tanaka", "Silva", "Novak", "Haddad", "Kowalski", "Byrne", "Castillo", "Fischer", "Adeyemi"];
const TAGS: Readonly<Record<Genre, readonly string[]>> = {
  fiction: ["novel", "mystery", "romance", "thriller", "classic"],
  science: ["physics", "biology", "astronomy", "chemistry", "popular-science"],
  history: ["ancient", "medieval", "modern", "biography", "war"],
  poetry: ["sonnets", "anthology", "lyric", "modern"],
  children: ["picture-book", "bedtime", "adventure", "animals"],
  technology: ["programming", "networks", "databases", "security", "design"],
  philosophy: ["ethics", "logic", "metaphysics", "classic"],
  travel: ["guide", "memoir", "maps", "adventure"],
};

export function isbnFor(n: number): string {
  const body = `978${String(100000000 + n * 7919).slice(-9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return `${body.slice(0, 3)}-${body.slice(3, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${check}`;
}

export interface SeedSize {
  readonly books: number;
  readonly members: number;
  readonly loans: number;
}

export async function seed(service: LibraryService, size: SeedSize, rng = new Prng(20240611)): Promise<void> {
  const authors: string[] = [];
  for (let i = 0; i < 48; i++) authors.push(`${rng.pick(FIRST)} ${rng.pick(LAST)}`);
  for (let i = 0; i < size.books; i++) {
    const genre = rng.pick(GENRES);
    const draft: BookDraft = {
      isbn: isbnFor(i + 1),
      title: `The ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}${i % 7 === 0 ? ` ${rng.int(2, 9)}` : ""}`,
      author: rng.pick(authors),
      genre,
      format: rng.pick(FORMATS),
      year: rng.int(1890, 2024),
      pages: rng.int(48, 960),
      copies: rng.int(1, 6),
      tags: rng.sample(TAGS[genre], rng.int(1, 3)),
      rating: Math.round(rng.next() * 50) / 10,
    };
    await service.createBook(draft);
  }
  const tiers: MemberTier[] = ["basic", "basic", "basic", "premium", "premium", "staff"];
  for (let i = 0; i < size.members; i++) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    await service.createMember({ name: `${first} ${last}`, email: `${first}.${last}.${i}@example.org`.toLowerCase(), tier: rng.pick(tiers) });
  }
  const bookIds = [...service.books.all()].map((b) => b.id);
  const memberIds = [...service.members.all()].map((m) => m.id);
  let opened = 0;
  for (let attempt = 0; opened < size.loans && attempt < size.loans * 4; attempt++) {
    try {
      const loan = await service.openLoan(rng.pick(bookIds), rng.pick(memberIds), rng.int(7, 42));
      opened++;
      if (rng.next() < 0.45) {
        const dueMs = loan.state.kind === "active" ? Date.parse(loan.state.dueAt) : 0;
        await service.closeLoan(loan.id, rng.next() < 0.08 ? "lost" : "returned", dueMs + rng.int(-10, 6) * 86_400_000);
      }
    } catch {
      // A rule violation (no copies, limit reached) just skips this draw.
    }
  }
}
