// Tokenise a file with the *real* VS Code TextMate engine, so scope output here is
// exactly what the editor produces. tools/engine.mjs loads it from VS Code itself.
//
//   ./tools/tm tools/tokenize.mjs <file> [--grep REGEX] [--raw]
//
// --grep  only print lines whose text matches REGEX
// --raw   omit our injections, showing the stock LaTeX tokenisation alone

import fs from "node:fs";
import { INITIAL, grammarFor, registry } from "./engine.mjs";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const raw = args.includes("--raw");
const grepAt = args.indexOf("--grep");
const grep = grepAt === -1 ? null : new RegExp(args[grepAt + 1]);

if (!file) {
    console.error("usage: tokenize.mjs <file> [--grep REGEX] [--raw]");
    process.exit(2);
}

const grammar = await grammarFor(registry({ inject: !raw }), file);

// Drop only the root scopes, which are on every token and tell us nothing. The tikz
// environment scope stays visible: it is the injection anchor, so seeing it is the point.
const NOISE = /^(text\.tex\.latex(\.tikz-file)?|text\.tex)$/;

const text = fs.readFileSync(file, "utf8");
let stack = INITIAL;
let lineNo = 0;

for (const line of text.split(/\r?\n/)) {
    lineNo++;
    const result = grammar.tokenizeLine(line, stack);
    stack = result.ruleStack;
    if (grep && !grep.test(line)) continue;

    console.log(`\x1b[2m${String(lineNo).padStart(4)}\x1b[0m  ${line}`);
    for (const t of result.tokens) {
        const piece = line.slice(t.startIndex, t.endIndex);
        if (!piece.trim()) continue;
        const scopes = t.scopes.filter((s) => !NOISE.test(s));
        if (!scopes.length) continue;
        const mine = scopes.some((s) => s.endsWith(".tikz"));
        const colour = mine ? "\x1b[32m" : "\x1b[2m";
        console.log(`      ${colour}${JSON.stringify(piece).padEnd(24)}\x1b[0m ${colour}${scopes.join(" ")}\x1b[0m`);
    }
}
