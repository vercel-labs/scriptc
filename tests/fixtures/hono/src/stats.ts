/* Aggregates for the stats endpoint: per-genre and per-decade breakdowns,
 * rating histogram, top authors and lending figures, computed in one pass
 * over each repository. */

import { GENRES, type Book, type Genre, type Loan } from "./domain.ts";
import type { LibraryService } from "./service.ts";

export interface GenreStats {
  readonly genre: Genre;
  readonly titles: number;
  readonly copies: number;
  readonly averageRating: number;
  readonly averagePages: number;
}

export interface AuthorStats {
  readonly author: string;
  readonly titles: number;
  readonly averageRating: number;
}

export interface LibraryStats {
  readonly catalogue: {
    readonly titles: number;
    readonly copies: number;
    readonly distinctAuthors: number;
    readonly distinctTags: number;
    readonly oldestYear: number | null;
    readonly newestYear: number | null;
  };
  readonly genres: GenreStats[];
  readonly decades: Record<string, number>;
  readonly ratingHistogram: number[];
  readonly topAuthors: AuthorStats[];
  readonly topTags: { readonly tag: string; readonly titles: number }[];
  readonly lending: {
    readonly members: number;
    readonly activeLoans: number;
    readonly returnedLoans: number;
    readonly lostLoans: number;
    readonly lateReturns: number;
    readonly utilization: number;
    readonly busiestMember: string | null;
  };
}

class Accumulator {
  count = 0;
  sum = 0;

  add(value: number): void {
    this.count++;
    this.sum += value;
  }

  mean(): number {
    return this.count === 0 ? 0 : round2(this.sum / this.count);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function topN<K>(counts: Map<K, number>, n: number, label: (key: K) => string): [K, number][] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (label(a[0]) < label(b[0]) ? -1 : label(a[0]) > label(b[0]) ? 1 : 0))
    .slice(0, n);
}

export function computeStats(service: LibraryService): LibraryStats {
  const genreTitles = new Map<Genre, { copies: number; rating: Accumulator; pages: Accumulator }>();
  for (const genre of GENRES) genreTitles.set(genre, { copies: 0, rating: new Accumulator(), pages: new Accumulator() });
  const authors = new Map<string, Accumulator>();
  const decades: Record<string, number> = {};
  const histogram = [0, 0, 0, 0, 0];
  let copies = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  const books: Book[] = [...service.books.all()];
  for (const book of books) {
    copies += book.copies;
    const g = genreTitles.get(book.genre)!;
    g.copies += book.copies;
    g.rating.add(book.rating);
    g.pages.add(book.pages);
    let author = authors.get(book.author);
    if (author === undefined) {
      author = new Accumulator();
      authors.set(book.author, author);
    }
    author.add(book.rating);
    const decade = `${Math.floor(book.year / 10) * 10}s`;
    decades[decade] = (decades[decade] ?? 0) + 1;
    histogram[Math.min(4, Math.max(0, Math.ceil(book.rating) - 1))]!++;
    oldest = oldest === null ? book.year : Math.min(oldest, book.year);
    newest = newest === null ? book.year : Math.max(newest, book.year);
  }

  const sortedDecades: Record<string, number> = {};
  for (const key of Object.keys(decades).sort()) sortedDecades[key] = decades[key]!;

  const authorCounts = new Map<string, number>();
  for (const [name, acc] of authors) authorCounts.set(name, acc.count);
  const tagCounts = service.books.countBy("tag");

  const perMember = new Map<string, number>();
  let active = 0;
  let returned = 0;
  let lost = 0;
  let late = 0;
  for (const loan of service.loans.all() as IterableIterator<Loan>) {
    switch (loan.state.kind) {
      case "active":
        active++;
        perMember.set(loan.memberId, (perMember.get(loan.memberId) ?? 0) + 1);
        break;
      case "returned":
        returned++;
        if (loan.state.lateDays > 0) late++;
        break;
      case "lost":
        lost++;
        break;
    }
  }
  const busiest = topN(perMember, 1, (id) => id)[0];

  return {
    catalogue: {
      titles: books.length,
      copies,
      distinctAuthors: authors.size,
      distinctTags: tagCounts.size,
      oldestYear: oldest,
      newestYear: newest,
    },
    genres: GENRES.map((genre) => {
      const g = genreTitles.get(genre)!;
      return {
        genre,
        titles: g.rating.count,
        copies: g.copies,
        averageRating: g.rating.mean(),
        averagePages: Math.round(g.pages.mean()),
      };
    }).filter((g) => g.titles > 0),
    decades: sortedDecades,
    ratingHistogram: histogram,
    topAuthors: topN(authorCounts, 5, (a) => a).map(([author, titles]) => ({
      author,
      titles,
      averageRating: authors.get(author)!.mean(),
    })),
    topTags: topN(tagCounts, 5, (t) => t).map(([tag, titles]) => ({ tag, titles })),
    lending: {
      members: service.members.size,
      activeLoans: active,
      returnedLoans: returned,
      lostLoans: lost,
      lateReturns: late,
      utilization: copies === 0 ? 0 : round2(active / copies),
      busiestMember: busiest === undefined ? null : busiest[0],
    },
  };
}
