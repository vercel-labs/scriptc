/* Domain model of the lending library: catalogue items, members, loans and
 * the event log that the change feed streams. */

export const GENRES = [
  "fiction",
  "science",
  "history",
  "poetry",
  "children",
  "technology",
  "philosophy",
  "travel",
] as const;
export type Genre = (typeof GENRES)[number];

export const FORMATS = ["hardcover", "paperback", "ebook", "audiobook"] as const;
export type Format = (typeof FORMATS)[number];

export interface Book {
  readonly id: string;
  readonly isbn: string;
  readonly title: string;
  readonly author: string;
  readonly genre: Genre;
  readonly format: Format;
  readonly year: number;
  readonly pages: number;
  readonly copies: number;
  readonly tags: readonly string[];
  readonly rating: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export type BookDraft = Omit<Book, "id" | "createdAt" | "updatedAt" | "version">;
export type BookPatch = Partial<BookDraft>;

export type MemberTier = "basic" | "premium" | "staff";

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly tier: MemberTier;
  readonly suspended: boolean;
  readonly joinedAt: string;
}

export type MemberDraft = Pick<Member, "name" | "email" | "tier">;

export type LoanState =
  | { readonly kind: "active"; readonly dueAt: string }
  | { readonly kind: "returned"; readonly returnedAt: string; readonly lateDays: number }
  | { readonly kind: "lost"; readonly reportedAt: string; readonly fee: number };

export interface Loan {
  readonly id: string;
  readonly bookId: string;
  readonly memberId: string;
  readonly loanedAt: string;
  readonly state: LoanState;
}

export type LibraryEvent =
  | { readonly type: "book.created"; readonly at: string; readonly book: Book }
  | {
      readonly type: "book.updated";
      readonly at: string;
      readonly book: Book;
      readonly changed: readonly string[];
    }
  | { readonly type: "book.deleted"; readonly at: string; readonly id: string }
  | { readonly type: "member.joined"; readonly at: string; readonly member: Member }
  | { readonly type: "loan.opened"; readonly at: string; readonly loan: Loan }
  | { readonly type: "loan.closed"; readonly at: string; readonly loan: Loan };

export interface SequencedEvent {
  readonly seq: number;
  readonly event: LibraryEvent;
}

export const LOAN_LIMITS: Readonly<Record<MemberTier, number>> = {
  basic: 3,
  premium: 8,
  staff: 20,
};

export const DAILY_FEE_CENTS: Readonly<Record<Format, number>> = {
  hardcover: 25,
  paperback: 15,
  ebook: 0,
  audiobook: 10,
};

export function isOpen(loan: Loan): boolean {
  return loan.state.kind === "active";
}

export function eventSubject(event: LibraryEvent): string {
  switch (event.type) {
    case "book.created":
    case "book.updated":
      return event.book.id;
    case "book.deleted":
      return event.id;
    case "member.joined":
      return event.member.id;
    case "loan.opened":
    case "loan.closed":
      return event.loan.id;
  }
}
