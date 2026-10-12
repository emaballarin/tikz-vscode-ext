// Exercise the semantic-token logic without VS Code.
//
//   ./tools/tm tools/symbols-check.mjs <file> [--index <dir>]
//
// src/symbols.js is deliberately free of any vscode import, so the part that decides
// what gets highlighted can be checked directly against real files.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { collectMacroDefinitions, collectStyleDefinitions, macroTokens, styleTokens } = require(
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
                // As the provider's own scan does, which excludes **/node_modules/**.
                if (entry.name !== ".git" && entry.name !== "node_modules") walk(p);
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

// The same functions the provider calls, so what is printed is what will be highlighted.
const uses = macroTokens(text);
const useLines = new Map();
for (const t of uses) {
    const name = text.slice(t.start + 1, t.start + t.length);
    useLines.set(name, (useLines.get(name) ?? []).concat(lineOf(t.start)));
}
console.log(`\n\x1b[1mmacro occurrences that will be highlighted: ${uses.length}\x1b[0m`);
for (const [name, lines] of useLines) console.log(`  \x1b[33m\\${name}\x1b[0m  lines ${lines.join(", ")}`);

const hits = styleTokens(text, known);
console.log(`\n\x1b[1mstyle references that will be highlighted: ${hits.length}\x1b[0m`);
for (const h of hits) {
    const name = text.slice(h.start, h.start + h.length);
    console.log(`  \x1b[36m${name}\x1b[0m  line ${lineOf(h.start)}${h.declaration ? "  (definition)" : ""}`);
}
