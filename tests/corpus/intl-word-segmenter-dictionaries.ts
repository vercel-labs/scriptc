// @requires-icu
// @env: LC_ALL=en_US.UTF-8
// Word segmentation of scripts written without spaces: Chinese, Japanese,
// Thai, Lao, Khmer and Burmese. ICU breaks them with the dictionaries in its
// data file (brkitr/*.dict), as Node does; each line lists a text's word-like
// segments and the boundaries of all its segments.
const texts = [
  "我们今天去北京大学参观博物馆。",
  "東京都の天気は晴れです。日本語の文章を単語に分けます。",
  "ภาษาไทยเป็นภาษาที่ไม่มีการเว้นวรรคระหว่างคำ",
  "ພາສາລາວເປັນພາສາທີ່ສວຍງາມ",
  "ភាសាខ្មែរគឺជាភាសាផ្លូវការរបស់ប្រទេសកម្ពុជា",
  "မြန်မာဘာသာစကားသည်မြန်မာနိုင်ငံ၏ရုံးသုံးဘာသာဖြစ်သည်",
  "한국어는 띄어쓰기를 합니다.",
];
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
for (const text of texts) {
  const words: string[] = [];
  const boundaries: number[] = [];
  for (const { segment, index, isWordLike } of segmenter.segment(text)) {
    boundaries.push(index);
    if (isWordLike === true) words.push(segment);
  }
  console.log(words.join("|"), boundaries.join(","));
}
