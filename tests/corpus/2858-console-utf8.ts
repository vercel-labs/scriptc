// Console and process.stdout output preserve Unicode characters, box-drawing
// glyphs, and tabs/newlines across console.log and process.stdout.write.
console.log("unicode box: ─── · › ☕");
process.stdout.write("café ☕ — tabs\tand\nnewlines\n");
console.log("done");
