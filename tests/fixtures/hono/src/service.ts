/* The typed service layer: catalogue, membership and lending rules on top
 * of the repositories. Handlers only translate HTTP to these calls. */

import { DAY_MS, daysBetween, iso, type Clock } from "./clock.ts";
import {
  DAILY_FEE_CENTS,
  LOAN_LIMITS,
  isOpen,
  type Book,
  type BookDraft,
  type BookPatch,
  type Format,
  type Genre,
  type LibraryEvent,
  type Loan,
  type Member,
  type MemberDraft,
} from "./domain.ts";
import { BusinessRuleError, PreconditionFailedError, type RuleViolation } from "./errors.ts";
import { EventLog } from "./events.ts";
import { Repository, type Lookup, type Page, type SortKey } from "./repository.ts";

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const BOOK_SORTS = ["title", "-title", "year", "-year", "rating", "-rating", "pages", "-pages", "added", "-added"] as const;
export type BookSort = (typeof BOOK_SORTS)[number];

export interface BookFilter {
  readonly genre?: Genre;
  readonly format?: Format;
  readonly author?: string;
  readonly tag?: string;
  readonly q?: string;
  readonly minYear?: number;
  readonly maxYear?: number;
  readonly minRating?: number;
  readonly available?: boolean;
  readonly sort: BookSort;
  readonly offset: number;
  readonly limit: number;
}

export interface LoanQuote {
  readonly bookId: string;
  readonly memberId: string;
  readonly days: number;
  readonly dueAt: string;
  readonly dailyFeeCents: number;
  readonly totalFeeCents: number;
  readonly discountPercent: number;
  readonly remainingLoans: number;
}

export interface Availability {
  readonly copies: number;
  readonly onLoan: number;
  readonly available: number;
}

export type BookView = Book & { readonly availability: Availability };

const SORT_KEYS: Readonly<Record<BookSort, SortKey<Book>[]>> = {
  title: [{ by: (b) => b.title, direction: "asc" }],
  "-title": [{ by: (b) => b.title, direction: "desc" }],
  year: [
    { by: (b) => b.year, direction: "asc" },
    { by: (b) => b.title, direction: "asc" },
  ],
  "-year": [
    { by: (b) => b.year, direction: "desc" },
    { by: (b) => b.title, direction: "asc" },
  ],
  rating: [
    { by: (b) => b.rating, direction: "asc" },
    { by: (b) => b.id, direction: "asc" },
  ],
  "-rating": [
    { by: (b) => b.rating, direction: "desc" },
    { by: (b) => b.id, direction: "asc" },
  ],
  pages: [{ by: (b) => b.pages, direction: "asc" }],
  "-pages": [{ by: (b) => b.pages, direction: "desc" }],
  added: [{ by: (b) => b.id, direction: "asc" }],
  "-added": [{ by: (b) => b.id, direction: "desc" }],
};

function normalizeAuthor(author: string): string {
  return author.trim().toLowerCase();
}

function padId(prefix: string, n: number): string {
  return `${prefix}_${String(n).padStart(5, "0")}`;
}

export class LibraryService {
  readonly books = new Repository<Book>("book", [
    { name: "isbn", key: (b) => b.isbn, unique: true },
    { name: "genre", key: (b) => b.genre },
    { name: "format", key: (b) => b.format },
    { name: "author", key: (b) => normalizeAuthor(b.author) },
    { name: "tag", key: (b) => b.tags },
  ]);
  readonly members = new Repository<Member>("member", [
    { name: "email", key: (m) => m.email.toLowerCase(), unique: true },
    { name: "tier", key: (m) => m.tier },
  ]);
  readonly loans = new Repository<Loan>("loan", [
    { name: "book", key: (l) => l.bookId },
    { name: "member", key: (l) => l.memberId },
    { name: "state", key: (l) => l.state.kind },
  ]);
  readonly events = new EventLog<LibraryEvent>(1000);
  private readonly onLoanCounts = new Map<string, number>();
  private sequence = 0;

  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  // ---- catalogue -------------------------------------------------------

  availability(book: Book): Availability {
    const onLoan = this.onLoanCounts.get(book.id) ?? 0;
    return { copies: book.copies, onLoan, available: Math.max(0, book.copies - onLoan) };
  }

  view(book: Book): BookView {
    return { ...book, availability: this.availability(book) };
  }

  async getBook(id: string): Promise<Book> {
    return this.books.require(id);
  }

  async listBooks(filter: BookFilter): Promise<Page<Book>> {
    const lookups: Lookup[] = [];
    if (filter.genre !== undefined) lookups.push({ index: "genre", key: filter.genre });
    if (filter.format !== undefined) lookups.push({ index: "format", key: filter.format });
    if (filter.author !== undefined) lookups.push({ index: "author", key: normalizeAuthor(filter.author) });
    if (filter.tag !== undefined) lookups.push({ index: "tag", key: filter.tag });
    const needle = filter.q?.toLowerCase();
    const { minYear, maxYear, minRating, available } = filter;
    return this.books.query({
      lookups,
      where: (book) => {
        if (minYear !== undefined && book.year < minYear) return false;
        if (maxYear !== undefined && book.year > maxYear) return false;
        if (minRating !== undefined && book.rating < minRating) return false;
        if (available !== undefined && this.availability(book).available > 0 !== available) return false;
        if (needle !== undefined && !book.title.toLowerCase().includes(needle) && !book.author.toLowerCase().includes(needle)) {
          return false;
        }
        return true;
      },
      sort: SORT_KEYS[filter.sort],
      offset: filter.offset,
      limit: filter.limit,
    });
  }

  async createBook(draft: BookDraft): Promise<Book> {
    const now = iso(this.clock.now());
    const book: Book = {
      ...draft,
      tags: [...new Set(draft.tags)].sort(),
      id: padId("bk", ++this.sequence),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.books.insert(book);
    this.events.append({ type: "book.created", at: now, book });
    return book;
  }

  async updateBook(id: string, patch: BookPatch, expectedVersion: number | null): Promise<Book> {
    const current = this.books.require(id);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw new PreconditionFailedError(String(expectedVersion), String(current.version));
    }
    const changed: string[] = [];
    for (const key of Object.keys(patch) as (keyof BookPatch)[]) {
      const before = current[key];
      const after = patch[key];
      if (after === undefined) continue;
      if (Array.isArray(before) && Array.isArray(after)) {
        if (before.join("\u0000") !== after.join("\u0000")) changed.push(key);
      } else if (before !== after) changed.push(key);
    }
    if (changed.length === 0) return current;
    const now = iso(this.clock.now());
    const next: Book = {
      ...current,
      ...patch,
      tags: patch.tags === undefined ? current.tags : [...new Set(patch.tags)].sort(),
      updatedAt: now,
      version: current.version + 1,
    };
    this.books.replace(next);
    changed.sort();
    this.events.append({ type: "book.updated", at: now, book: next, changed });
    return next;
  }

  async deleteBook(id: string): Promise<void> {
    const open = this.loans.findBy("book", id).filter(isOpen).length;
    if (open > 0) throw new BusinessRuleError({ rule: "has_active_loans", count: open });
    this.books.delete(id);
    this.onLoanCounts.delete(id);
    this.events.append({ type: "book.deleted", at: iso(this.clock.now()), id });
  }

  // ---- membership --------------------------------------------------------

  async createMember(draft: MemberDraft): Promise<Member> {
    const member: Member = {
      id: padId("mb", ++this.sequence),
      name: draft.name.trim(),
      email: draft.email.toLowerCase(),
      tier: draft.tier,
      suspended: false,
      joinedAt: iso(this.clock.now()),
    };
    this.members.insert(member);
    this.events.append({ type: "member.joined", at: member.joinedAt, member });
    return member;
  }

  async suspend(memberId: string, suspended: boolean): Promise<Member> {
    const member = this.members.require(memberId);
    return this.members.replace({ ...member, suspended });
  }

  memberLoans(memberId: string, state: Loan["state"]["kind"] | undefined): Loan[] {
    this.members.require(memberId);
    const loans = this.loans.findBy("member", memberId);
    return state === undefined ? loans : loans.filter((loan) => loan.state.kind === state);
  }

  // ---- lending -----------------------------------------------------------

  private check(book: Book, member: Member): Result<number, RuleViolation> {
    if (member.suspended) return { ok: false, error: { rule: "member_suspended", memberId: member.id } };
    const limit = LOAN_LIMITS[member.tier];
    let held = 0;
    for (const loan of this.loans.findBy("member", member.id)) if (isOpen(loan)) held++;
    if (held >= limit) return { ok: false, error: { rule: "loan_limit_reached", memberId: member.id, limit } };
    if (this.availability(book).available === 0) return { ok: false, error: { rule: "no_copies_available", bookId: book.id } };
    return { ok: true, value: limit - held };
  }

  quote(bookId: string, memberId: string, days: number): LoanQuote {
    const book = this.books.require(bookId);
    const member = this.members.require(memberId);
    const verdict = this.check(book, member);
    if (!verdict.ok) throw new BusinessRuleError(verdict.error);
    const daily = DAILY_FEE_CENTS[book.format];
    const discountPercent = member.tier === "staff" ? 100 : member.tier === "premium" ? 50 : days > 14 ? 10 : 0;
    const total = Math.round((daily * days * (100 - discountPercent)) / 100);
    return {
      bookId,
      memberId,
      days,
      dueAt: iso(Date.parse(book.updatedAt) + days * DAY_MS),
      dailyFeeCents: daily,
      totalFeeCents: total,
      discountPercent,
      remainingLoans: verdict.value - 1,
    };
  }

  async openLoan(bookId: string, memberId: string, days: number): Promise<Loan> {
    const book = this.books.require(bookId);
    const member = this.members.require(memberId);
    const verdict = this.check(book, member);
    if (!verdict.ok) throw new BusinessRuleError(verdict.error);
    const now = this.clock.now();
    const loan: Loan = {
      id: padId("ln", ++this.sequence),
      bookId,
      memberId,
      loanedAt: iso(now),
      state: { kind: "active", dueAt: iso(now + days * DAY_MS) },
    };
    this.loans.insert(loan);
    this.onLoanCounts.set(bookId, (this.onLoanCounts.get(bookId) ?? 0) + 1);
    this.events.append({ type: "loan.opened", at: loan.loanedAt, loan });
    return loan;
  }

  async closeLoan(loanId: string, outcome: "returned" | "lost", atMs?: number): Promise<Loan> {
    const loan = this.loans.require(loanId);
    if (loan.state.kind !== "active") throw new BusinessRuleError({ rule: "already_returned", loanId });
    const now = atMs ?? this.clock.now();
    const dueAt = loan.state.dueAt;
    const book = this.books.get(loan.bookId);
    const closed: Loan = {
      ...loan,
      state:
        outcome === "returned"
          ? { kind: "returned", returnedAt: iso(now), lateDays: Math.max(0, daysBetween(dueAt, now)) }
          : { kind: "lost", reportedAt: iso(now), fee: book === undefined ? 0 : 500 + book.pages * 2 },
    };
    this.loans.replace(closed);
    const count = (this.onLoanCounts.get(loan.bookId) ?? 1) - 1;
    if (count === 0) this.onLoanCounts.delete(loan.bookId);
    else this.onLoanCounts.set(loan.bookId, count);
    this.events.append({ type: "loan.closed", at: iso(now), loan: closed });
    return closed;
  }
}
