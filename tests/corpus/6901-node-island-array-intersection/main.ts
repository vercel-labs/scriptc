// @requires-libnode
// Reading an element of an island array whose declared type is an
// INTERSECTION of two array types — `Choice[] & GenChoice[]`, the island's
// choices extended by the caller's own choice type — has no native
// representation of its own, so the array stays a handle and the read runs
// in the island; the fields the declaration names cross back out.
import { extendedImageResponse, imageResponse, unsafe } from "choicekit";
import type { Choice } from "choicekit";

const extended = extendedImageResponse();
const first = extended.choices[0];
console.log(first.index, first.text);
console.log(first.images === undefined ? "no-images" : first.images.join("+"));

const second = extended.choices[1];
console.log(second.index, second.text, second.images === undefined ? "no-images" : second.images.join("+"));

/** The caller's own choice type over the island's array. */
interface NativeChoice extends Choice {
  readonly images?: string[];
}

const third = unsafe<Choice[] & NativeChoice[]>(imageResponse().choices)[1];
console.log(third.text, third.images === undefined ? "no-images" : third.images.join("+"));
