"use strict";

// Exercises src/symbols.js, which decides what the semantic provider highlights and,
// happily, imports nothing from `vscode` -- so it runs under a bare node, or under the
// node inside VS Code when tools/test finds no other.

const assert = require("assert");
const { collectMacroDefinitions, collectStyleDefinitions, optionRegions, optionItemNames } = require("../src/symbols");

let run = 0;

function test(name, body) {
    run += 1;
    try {
        body();
    } catch (error) {
        console.error(`FAIL ${name}\n  ${error.message}`);
        process.exitCode = 1;
    }
}

/** The text of every option region, in order. */
function regions(text) {
    return optionRegions(text).map(({ start, end }) => text.slice(start, end));
}

/** The item names in every option region, flattened. */
function items(text) {
    return optionRegions(text).flatMap((region) => optionItemNames(text, region));
}

test("every defining form yields its macro, offset at the name", () => {
    const forms = [
        "\\def\\a{1}",
        "\\gdef\\a{1}",
        "\\edef\\a{1}",
        "\\xdef\\a{1}",
        "\\newcommand{\\a}{1}",
        "\\renewcommand*{\\a}{1}",
        "\\providecommand{ \\a }{1}",
        "\\newcommand\\a{1}",
        "\\let\\a\\relax",
        "\\pgfmathsetmacro{\\a}{1+1}",
        "\\pgfmathsetlengthmacro{\\a}{1pt}",
    ];
    for (const form of forms) {
        const found = collectMacroDefinitions(form);
        assert.deepStrictEqual([...found.keys()], ["a"], form);
        assert.strictEqual(form[found.get("a")], "a", `${form}: offset should point at the name`);
    }
});

test("the first definition of a macro is the one recorded", () => {
    const text = "\\def\\eps{1}\n\\def\\eps{2}";
    assert.strictEqual(collectMacroDefinitions(text).get("eps"), 5);
});

test("a use is not a definition", () => {
    assert.strictEqual(collectMacroDefinitions("\\draw (0,\\eps) -- (1,1);").size, 0);
});

test("style definitions are found by handler, with multi-word names", () => {
    const text = [
        "\\tikzset{",
        "  neuron/.style={circle},",
        "  every node/.append style={font=\\small},",
        "  pair/.style 2 args={#1, #2},",
        "  big/.code={\\pgfkeysalso{scale=2}},",
        "}",
    ].join("\n");
    assert.deepStrictEqual([...collectStyleDefinitions(text).keys()], ["neuron", "every node", "pair", "big"]);
});

test("a slash in the middle of a value does not invent a style", () => {
    assert.strictEqual(collectStyleDefinitions("\\node [label=a/.style] {};").size, 0);
});

test("option regions are gated to pictures, keysets and inline \\tikz", () => {
    const text = [
        "\\vx[n] outside any picture",
        "\\begin{tikzpicture}[scale=2]",
        "  \\draw [thick, neuron] (0,0) -- (1,1);",
        "  \\node at (0,0) {$\\vx[n]$};",
        "  % \\draw [commented] (0,0);",
        "\\end{tikzpicture}",
        "\\tikzset{flow/.style={->}}",
        "inline \\tikz \\draw [red] (0,0) -- (1,0); then [after] the semicolon",
    ].join("\n");
    assert.deepStrictEqual(regions(text), ["scale=2", "thick, neuron", "flow/.style={->}", "->", "red"]);
});

test("item names skip separators and comments, and record whether a value follows", () => {
    const text =
        "\\begin{tikzpicture}[\n  % a comment\n  school axis,\n  x=xc, every node/.style={draw}]\\end{tikzpicture}";
    const names = items(text).map(({ name, hasValue }) => [name, hasValue]);
    assert.deepStrictEqual(names.slice(0, 3), [
        ["school axis", false],
        ["x", true],
        ["every node/.style", true],
    ]);
    const first = items(text)[0];
    assert.strictEqual(text.slice(first.start, first.start + first.name.length), "school axis");
});

if (!process.exitCode) console.log(`ok: ${run} symbol tests`);
