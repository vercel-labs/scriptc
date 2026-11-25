// A workspace package that holds only type declarations: `main` and `types`
// both name this file, and nothing in the package runs.
export interface Book {
  isbn: string;
  title: string;
  year?: number;
}

export interface Member {
  card: string;
  name: string;
  branch: string;
  joined?: number;
}

export type Condition = "good" | "worn";

export type Shelf = { code: string; books: Book[] };

export interface Loan {
  ticket: string;
  condition: Condition;
  book: Book;
  stamps: string[];
}

export interface Batch<T> {
  rows: T[];
  cursor?: string;
}

export interface Counter {
  unit: string;
  add(note: string): void;
}

export interface Notices {
  onReturn?: (book: Book) => string;
}
