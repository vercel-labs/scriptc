import wordform from "wordform";

export const fromLeft = wordform;

export function countLeft(word: string): string {
  return wordform(word, 2) + "/" + wordform(word, 1);
}
