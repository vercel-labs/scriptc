// A workspace package that holds only declarations. Its interfaces are
// types; its class, enum, constant and function declare values that no
// implementation provides.
export interface Book {
  isbn: string;
  title: string;
}
export declare class Stamp {
  ink: string;
  constructor(ink: string);
  press(): string;
}
export declare enum Floor {
  Ground = 0,
  Upper = 1,
}
export declare const EDITION: string;
export declare function bind(isbn: string): Book;
