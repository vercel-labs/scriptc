/* Request schemas. Bodies are strict objects; query strings are coerced
 * from their string form with explicit bounds so bad input yields a 400
 * listing every offending field. */

import { z } from "zod";
import { FORMATS, GENRES } from "./domain.ts";
import { BOOK_SORTS } from "./service.ts";

const isbn = z
  .string()
  .regex(/^97[89]-\d{1,5}-\d{1,7}-\d{1,7}-\d$/, "must be an ISBN-13 with hyphens")
  .refine((value) => isbn13Valid(value), "has an invalid check digit");

export function isbn13Valid(value: string): boolean {
  const digits = value.replace(/-/g, "");
  if (digits.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(digits[12]);
}

const tag = z
  .string()
  .min(2)
  .max(24)
  .regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case");

const bookFields = {
  isbn,
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().min(1).max(120),
  genre: z.enum(GENRES),
  format: z.enum(FORMATS),
  year: z.number().int().min(1450).max(2100),
  pages: z.number().int().positive().max(20000),
  copies: z.number().int().min(0).max(500),
  tags: z.array(tag).max(12),
  rating: z.number().min(0).max(5),
};

export const bookDraftSchema = z.strictObject({
  ...bookFields,
  format: bookFields.format.default("paperback"),
  copies: bookFields.copies.default(1),
  tags: bookFields.tags.default([]),
  rating: bookFields.rating.default(0),
});

export const bookPatchSchema = z
  .strictObject(bookFields)
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "must change at least one field" });

export const memberDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  tier: z.enum(["basic", "premium", "staff"]).default("basic"),
});

export const loanRequestSchema = z.strictObject({
  bookId: z.string().regex(/^bk_\d{5}$/, "must be a book id"),
  memberId: z.string().regex(/^mb_\d{5}$/, "must be a member id"),
  days: z.number().int().min(1).max(60).default(21),
});

export const loanCloseSchema = z.strictObject({
  outcome: z.enum(["returned", "lost"]).default("returned"),
});

const boolString = z.enum(["true", "false"]).transform((value) => value === "true");

export const bookListQuerySchema = z.object({
  genre: z.enum(GENRES).optional(),
  format: z.enum(FORMATS).optional(),
  author: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  q: z.string().min(2).max(64).optional(),
  minYear: z.coerce.number().int().optional(),
  maxYear: z.coerce.number().int().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  available: boolString.optional(),
  sort: z.enum(BOOK_SORTS).default("added"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const memberLoansQuerySchema = z.object({
  state: z.enum(["active", "returned", "lost"]).optional(),
});

export const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^[a-z]{2}_\d{5}$/, "must be an entity id"),
});

export type BookDraftInput = z.infer<typeof bookDraftSchema>;
export type BookListQuery = z.infer<typeof bookListQuerySchema>;
