// Tokenise a file with the *real* VS Code TextMate engine, so scope output here is
// exactly what the editor produces. No npm install: VS Code ships Electron (a Node
// runtime), vscode-textmate, vscode-oniguruma and the stock LaTeX grammar.
//
//   ./tools/tm node tools/tokenize.mjs <file> [--grep REGEX] [--raw]
//
// --grep  only print lines whose text matches REGEX
// --raw   omit our injections, showing the stock LaTeX tokenisation alone

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const VSCODE = "/Applications/Visual Studio Code.app/Contents/Resources/app";
const vsctm = require(`${VSCODE}/node_modules.asar/vscode-textmate`);
const oniguruma = require(`${VSCODE}/node_modules.asar/vscode-oniguruma`);

const LATEX_SYNTAXES = `${VSCODE}/extensions/latex/syntaxes`;

// Host grammars we resolve for real. Anything else (embedded python, css, ...) resolves
// to null, which vscode-textmate handles by leaving the region untokenised.
const HOST = {
    "text.tex.latex": `${LATEX_SYNTAXES}/LaTeX.tmLanguage.json`,
    "text.tex": `${LATEX_SYNTAXES}/TeX.tmLanguage.json`,
    "text.bibtex": `${LATEX_SYNTAXES}/Bibtex.tmLanguage.json`,
    "source.cpp.embedded.latex": `${LATEX_SYNTAXES}/cpp-grammar-bailout.tmLanguage.json`,
};

// Our injections, read from package.json so the harness can never drift from what the
// extension actually contributes.
const pkg = JSON.parse(fs.readFileSync(`${REPO}/package.json`, "utf8"));
const OURS = Object.fromEntries((pkg.contributes?.grammars ?? []).map((g) => [g.scopeName, path.join(REPO, g.path)]));
const INJECT_INTO = {};
for (const g of pkg.contributes?.grammars ?? []) {
    for (const host of g.injectTo ?? []) (INJECT_INTO[host] ??= []).push(g.scopeName);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const raw = args.includes("--raw");
const grepAt = args.indexOf("--grep");
const grep = grepAt === -1 ? null : new RegExp(args[grepAt + 1]);

if (!file) {
    console.error("usage: tokenize.mjs <file> [--grep REGEX] [--raw]");
    process.exit(2);
}

// Electron intercepts any path containing ".asar", so it mis-reads the *.unpacked*
// sibling directory as an archive lookup. Disable that just for this read; the module
// requires above already happened and did need the interception.
process.noAsar = true;
const wasm = fs.readFileSync(`${VSCODE}/node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm`);
process.noAsar = false;
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
        createOnigScanner: (s) => new oniguruma.OnigScanner(s),
        createOnigString: (s) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName) => {
        const p = OURS[scopeName] ?? HOST[scopeName];
        if (!p) return null;
        return vsctm.parseRawGrammar(fs.readFileSync(p, "utf8"), p);
    },
    getInjections: (scopeName) => (raw ? undefined : INJECT_INTO[scopeName]),
});

// A .tikz file is a picture body on its own and has a root grammar of its own; anything
// else is a LaTeX document that happens to contain figures.
const root = file.endsWith(".tikz") ? "text.tex.latex.tikz-file" : "text.tex.latex";
const grammar = await registry.loadGrammar(root);
if (!grammar) throw new Error(`could not load ${root}`);

// Drop only the root scopes, which are on every token and tell us nothing. The tikz
// environment scope stays visible: it is the injection anchor, so seeing it is the point.
const NOISE = /^(text\.tex\.latex(\.tikz-file)?|text\.tex)$/;

const text = fs.readFileSync(file, "utf8");
let stack = vsctm.INITIAL;
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
