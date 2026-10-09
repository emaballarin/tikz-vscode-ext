// The TextMate engine VS Code itself runs, with this extension's grammars registered.
//
// No npm install: VS Code ships vscode-textmate, vscode-oniguruma and the stock LaTeX
// grammar, and tools/tm runs scripts under VS Code's own Electron. The two libraries live
// inside an asar archive that only Electron can read, so this module refuses to load
// anywhere else -- and since it finds the installation from the runtime, the engine and
// the host grammar it loads always belong to the VS Code that tools/tm picked.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, findVSCode } from "./vscode.mjs";

const require = createRequire(import.meta.url);
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const found = findVSCode();
if (!found) {
    console.error(`${process.execPath} is not VS Code's Electron; run this through tools/tm`);
    process.exit(2);
}
const VSCODE = found.app;
/** Which VS Code produced the tokens, for any report that depends on it. */
export const VSCODE_BUILD = describe(found);

const vsctm = require(`${VSCODE}/node_modules.asar/vscode-textmate`);
const oniguruma = require(`${VSCODE}/node_modules.asar/vscode-oniguruma`);
export const INITIAL = vsctm.INITIAL;

const LATEX_SYNTAXES = `${VSCODE}/extensions/latex/syntaxes`;

// Host grammars we resolve for real. Anything else (embedded python, css, ...) resolves
// to null, which vscode-textmate handles by leaving the region untokenised.
const HOST = {
    "text.tex.latex": `${LATEX_SYNTAXES}/LaTeX.tmLanguage.json`,
    "text.tex": `${LATEX_SYNTAXES}/TeX.tmLanguage.json`,
    "text.bibtex": `${LATEX_SYNTAXES}/Bibtex.tmLanguage.json`,
    "source.cpp.embedded.latex": `${LATEX_SYNTAXES}/cpp-grammar-bailout.tmLanguage.json`,
};

// Our grammars, read from package.json so the harness can never drift from what the
// extension actually contributes.
const pkg = JSON.parse(fs.readFileSync(`${REPO}/package.json`, "utf8"));
const OURS = Object.fromEntries((pkg.contributes?.grammars ?? []).map((g) => [g.scopeName, path.join(REPO, g.path)]));
const INJECT_INTO = {};
for (const g of pkg.contributes?.grammars ?? []) {
    for (const host of g.injectTo ?? []) (INJECT_INTO[host] ??= []).push(g.scopeName);
}

// Electron intercepts any path containing ".asar", so it mis-reads the *.unpacked*
// sibling directory as an archive lookup. Disable that just for this read; the module
// requires above already happened and did need the interception.
process.noAsar = true;
const wasm = fs.readFileSync(`${VSCODE}/node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm`);
process.noAsar = false;
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

/**
 * A registry resolving the host grammars and ours, with our injections applied or not.
 * Without them the result is the stock LaTeX tokenisation, which is the baseline both for
 * --raw and for telling our own rules apart from the host's.
 * @param {{inject?: boolean}} [options]
 */
export function registry({ inject = true } = {}) {
    return new vsctm.Registry({
        onigLib: Promise.resolve({
            createOnigScanner: (s) => new oniguruma.OnigScanner(s),
            createOnigString: (s) => new oniguruma.OnigString(s),
        }),
        loadGrammar: async (scopeName) => {
            const p = OURS[scopeName] ?? HOST[scopeName];
            if (!p) return null;
            return vsctm.parseRawGrammar(fs.readFileSync(p, "utf8"), p);
        },
        getInjections: (scopeName) => (inject ? INJECT_INTO[scopeName] : undefined),
    });
}

/**
 * A .tikz file is a picture body on its own and has a root grammar of its own; anything
 * else is a LaTeX document that happens to contain figures.
 * @param {string} file
 */
export function rootScopeFor(file) {
    return file.endsWith(".tikz") ? "text.tex.latex.tikz-file" : "text.tex.latex";
}

/**
 * Load the root grammar for `file` from `reg`, failing loudly rather than tokenising
 * nothing.
 */
export async function grammarFor(reg, file) {
    const root = rootScopeFor(file);
    const grammar = await reg.loadGrammar(root);
    if (!grammar) throw new Error(`could not load ${root}`);
    return grammar;
}
