// Exercise the semantic-token logic without VS Code.
//
//   ./tools/tm tools/symbols-check.mjs <file> [--index <dir>]
//
// src/symbols.js is deliberately free of any vscode import, so the part that decides
// what gets highlighted can be checked directly against real files.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { MACRO_USE, collectMacroDefinitions, collectStyleDefinitions, optionRegions, optionItemNames } = require(
    `${REPO}/src/symbols.js`
);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const indexAt = args.indexOf("--index");
const indexDir = indexAt === -1 ? null : args[indexAt + 1];

if (!file) {
    console.error("usage: symbols-check.mjs <file> [--index <dir>]");
    process.exit(2);
}

// Stand in for the workspace style index.
const known = new Set();
if (indexDir) {
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name !== ".git") walk(p);
            } else if (/\.(tex|sty|cls|tikz)$/.test(entry.name)) {
                for (const name of collectStyleDefinitions(fs.readFileSync(p, "utf8")).keys()) known.add(name);
            }
        }
    };
    walk(indexDir);
    console.log(`\x1b[2mindex: ${known.size} styles from ${indexDir}\x1b[0m\n`);
}

const text = fs.readFileSync(file, "utf8");
const lineOf = (offset) => text.slice(0, offset).split("\n").length;

const macros = collectMacroDefinitions(text);
console.log(`\x1b[1mmacros defined in this file (${macros.size})\x1b[0m`);
for (const [name, at] of macros) console.log(`  \x1b[33m\\${name}\x1b[0m  line ${lineOf(at)}`);

let uses = 0;
MACRO_USE.lastIndex = 0;
let m;
const useLines = new Map();
while ((m = MACRO_USE.exec(text)) !== null) {
    if (!macros.has(m[1])) continue;
    uses++;
    const l = lineOf(m.index);
    useLines.set(m[1], (useLines.get(m[1]) ?? []).concat(l));
}
console.log(`\n\x1b[1mmacro occurrences that will be highlighted: ${uses}\x1b[0m`);
for (const [name, lines] of useLines) console.log(`  \x1b[33m\\${name}\x1b[0m  lines ${lines.join(", ")}`);

const local = collectStyleDefinitions(text);
const hits = [];
for (const region of optionRegions(text)) {
    for (const item of optionItemNames(text, region)) {
        const bare = item.name.replace(/\s*\/\..*$/, "").trim();
        if (!bare) continue;
        if (!known.has(bare) && !local.has(bare)) continue;
        hits.push({ bare, line: lineOf(item.start), declaration: local.get(bare) === item.start });
    }
}
console.log(`\n\x1b[1mstyle references that will be highlighted: ${hits.length}\x1b[0m`);
for (const h of hits) {
    console.log(`  \x1b[36m${h.bare}\x1b[0m  line ${h.line}${h.declaration ? "  (definition)" : ""}`);
}
