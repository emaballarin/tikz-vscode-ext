// Sweep many files and report anything that looks like a runaway block.
//
//   ./tools/tm tools/audit.mjs <file>...
//
// A begin/end rule whose end never matches swallows the rest of the file, which is the
// main way a grammar like this goes wrong. Tokenising to EOF and checking that our rules
// have unwound catches that across the whole corpus in one pass, which no amount of
// clicking around in the editor would. A fragment ending inside its picture is normal --
// it is \input into a parent -- so only *our* rules left open count; runawaySince in
// tools/engine.mjs says how that is told apart. Exits 1 when anything runs away.

import fs from "node:fs";
import path from "node:path";
import { INITIAL, grammarFor, ourScopes, registry, runawaySince } from "./engine.mjs";

const OURS = ourScopes();
const reg = registry();
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

let flagged = 0;
let totalOurs = 0;

for (const file of files) {
    const grammar = await grammarFor(reg, file);
    let stack = INITIAL;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const r = grammar.tokenizeLine(line, stack);
        stack = r.ruleStack;
        for (const t of r.tokens) if (t.scopes.some((s) => OURS.has(s))) totalOurs++;
    }

    const since = await runawaySince(file);
    if (since !== null) {
        flagged++;
        console.log(
            `\x1b[31mRUNAWAY\x1b[0m ${path.relative(process.cwd(), file)}  (a tikz rule opened by line ${since} is still open at EOF)`
        );
    }
}

console.log(`\n${files.length} files, ${totalOurs} tikz tokens, \x1b[${flagged ? 31 : 32}m${flagged} runaway\x1b[0m`);
if (flagged) process.exitCode = 1;
