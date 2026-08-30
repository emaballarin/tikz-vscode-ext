// Sweep many files and report anything that looks like a runaway block.
//
//   ./tools/tm tools/audit.mjs <file>...
//
// A begin/end rule whose end never matches swallows the rest of the file, which is the
// main way a grammar like this goes wrong. Tokenising to EOF and checking that the rule
// stack has unwound catches that across the whole corpus in one pass, which no amount of
// clicking around in the editor would.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const VSCODE = '/Applications/Visual Studio Code.app/Contents/Resources/app';
const vsctm = require(`${VSCODE}/node_modules.asar/vscode-textmate`);
const oniguruma = require(`${VSCODE}/node_modules.asar/vscode-oniguruma`);
const LATEX_SYNTAXES = `${VSCODE}/extensions/latex/syntaxes`;

const HOST = {
  'text.tex.latex': `${LATEX_SYNTAXES}/LaTeX.tmLanguage.json`,
  'text.tex': `${LATEX_SYNTAXES}/TeX.tmLanguage.json`,
  'text.bibtex': `${LATEX_SYNTAXES}/Bibtex.tmLanguage.json`,
  'source.cpp.embedded.latex': `${LATEX_SYNTAXES}/cpp-grammar-bailout.tmLanguage.json`,
};

const pkg = JSON.parse(fs.readFileSync(`${REPO}/package.json`, 'utf8'));
const OURS = Object.fromEntries(
  (pkg.contributes?.grammars ?? []).map((g) => [g.scopeName, path.join(REPO, g.path)]),
);
const INJECT_INTO = {};
for (const g of pkg.contributes?.grammars ?? []) {
  for (const host of g.injectTo ?? []) (INJECT_INTO[host] ??= []).push(g.scopeName);
}

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
    return vsctm.parseRawGrammar(fs.readFileSync(p, 'utf8'), p);
  },
  getInjections: (scopeName) => INJECT_INTO[scopeName],
});

// A .tikz file is a picture body on its own and has a root grammar of its own; anything
// else is a LaTeX document that happens to contain figures.
const grammars = {
  'text.tex.latex': await registry.loadGrammar('text.tex.latex'),
  'text.tex.latex.tikz-file': await registry.loadGrammar('text.tex.latex.tikz-file'),
};
const rootFor = (file) =>
  grammars[file.endsWith('.tikz') ? 'text.tex.latex.tikz-file' : 'text.tex.latex'];
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// A file that ends mid-environment is normal for the fragments in *-figs/, which are
// \input into a parent. Only *our* scopes left open at EOF are a defect.
let flagged = 0;
let totalOurs = 0;

for (const file of files) {
  const grammar = rootFor(file);
  let stack = vsctm.INITIAL;
  let ours = 0;
  let lineNo = 0;
  let openAt = null;

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    lineNo++;
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    for (const t of r.tokens) if (t.scopes.some((s) => s.endsWith('.tikz'))) ours++;

    const open = stack.contentNameScopesList?.scopeName ?? '';
    if (String(open).startsWith('tikz.') && openAt === null) openAt = lineNo;
  }

  totalOurs += ours;

  // Walk the final stack looking for one of our rules still open.
  const trail = [];
  for (let s = stack; s; s = s.parent) trail.push(s.nameScopesList?.scopeName ?? '');
  const stuck = trail.some((s) => String(s).endsWith('.tikz'));

  if (stuck) {
    flagged++;
    console.log(`\x1b[31mRUNAWAY\x1b[0m ${path.relative(process.cwd(), file)}  (a tikz rule is still open at EOF)`);
  }
}

console.log(`\n${files.length} files, ${totalOurs} tikz tokens, \x1b[${flagged ? 31 : 32}m${flagged} runaway\x1b[0m`);
