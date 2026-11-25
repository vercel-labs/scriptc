// A sloppy write to an undeclared name: the module runs in a Node island.
counter = 0;
exports.answer = () => ++counter;
