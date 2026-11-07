// A record held at a loose type (the discriminant a plain string, every
// other member optional) that reaches a discriminated union through `any`:
// alone, as an argument, as the elements of a list and as a list in a
// member of an argument. Each value takes the arm its discriminant names,
// whatever the layouts of the arms look like: here one arm declares an
// optional member the loose record lacks, and the other does not.
interface TextPart {
  type: "text";
  text: string;
  signature?: string;
}
interface ImagePart {
  type: "image";
  data: string;
  mimeType: string;
}
type Part = TextPart | ImagePart;
interface LoosePart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface Stored {
  content: LoosePart[];
  details?: any;
  isError: boolean;
}

function show(part: Part): string {
  return part.type === "text" ? part.text : `[${part.mimeType}:${part.data.length}]`;
}
function render(result: { content: Part[]; details?: unknown }): string {
  return result.content.map(show).join(" | ");
}

class View {
  private result?: Stored;
  update(result: Stored): void {
    this.result = result;
  }
  show(): string {
    if (!this.result) return "";
    try {
      return render({ content: this.result.content as any, details: this.result.details });
    } catch (error) {
      return `fallback: ${(error as Error).message}`;
    }
  }
}

const view = new View();
view.update({ content: [{ type: "text", text: "hello" }], isError: false });
console.log(view.show());
view.update({
  content: [
    { type: "image", data: "AAAA", mimeType: "image/png" },
    { type: "text", text: "note" },
  ],
  details: { n: 1 },
  isError: false,
});
console.log(view.show());
view.update({ content: [], isError: true });
console.log(JSON.stringify(view.show()));

// One value, and one value as an argument.
const text: LoosePart = { type: "text", text: "single" };
const image: LoosePart = { type: "image", data: "BB", mimeType: "image/gif" };
const asText: Part = text as any;
const asImage: Part = image as any;
console.log(show(asText), show(asImage), show(text as any), show(image as any));
console.log(JSON.stringify(asText), JSON.stringify(asImage));
console.log("signature" in asText, "data" in asText, "text" in asImage, "mimeType" in asImage);

// A list, converted as a whole and read back by its discriminant.
const loose: LoosePart[] = [text, image, { type: "text", text: "last" }];
const parts: Part[] = loose as any;
let texts = 0;
let images = 0;
for (const part of parts) {
  if (part.type === "text") texts += part.text.length;
  else images += part.data.length;
}
console.log(parts.length, texts, images, parts.map((part) => part.type).join(","));

// A member every arm declares at one type keeps working for both.
type Sized = { type: "a"; size: number; label?: string } | { type: "b"; size: number };
const sizes: { type: string; size: number }[] = [
  { type: "b", size: 2 },
  { type: "a", size: 3 },
];
const sized: Sized[] = sizes as any;
console.log(sized.map((s) => `${s.type}:${s.size}`).join(","));
