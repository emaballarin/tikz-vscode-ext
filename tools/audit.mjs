// Sweep many files and report anything that looks like a runaway block.
//
//   ./tools/tm tools/audit.mjs <file>...
//
// A begin/end rule whose end never matches swallows the rest of the file, which is the
// main way a grammar like this goes wrong. Tokenising to EOF and checking that the rule
// stack has unwound catches that across the whole corpus in one pass, which no amount of
// clicking around in the editor would.

import fs from "node:fs";
import path from "node:path";
import { INITIAL, grammarFor, registry } from "./engine.mjs";

const reg = registry();
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// A file that ends mid-environment is normal for the fragments in *-figs/, which are
// \input into a parent. Only *our* scopes left open at EOF are a defect.
let flagged = 0;
let totalOurs = 0;

for (const file of files) {
    const grammar = await grammarFor(reg, file);
    let stack = INITIAL;
    let ours = 0;
    let lineNo = 0;
    let openAt = null;

    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        lineNo++;
        const r = grammar.tokenizeLine(line, stack);
        stack = r.ruleStack;
        for (const t of r.tokens) if (t.scopes.some((s) => s.endsWith(".tikz"))) ours++;

        const open = stack.contentNameScopesList?.scopeName ?? "";
        if (String(open).startsWith("tikz.") && openAt === null) openAt = lineNo;
    }

    totalOurs += ours;

    // Walk the final stack looking for one of our rules still open.
    const trail = [];
    for (let s = stack; s; s = s.parent) trail.push(s.nameScopesList?.scopeName ?? "");
    const stuck = trail.some((s) => String(s).endsWith(".tikz"));

    if (stuck) {
        flagged++;
        console.log(`\x1b[31mRUNAWAY\x1b[0m ${path.relative(process.cwd(), file)}  (a tikz rule is still open at EOF)`);
    }
}

console.log(`\n${files.length} files, ${totalOurs} tikz tokens, \x1b[${flagged ? 31 : 32}m${flagged} runaway\x1b[0m`);
