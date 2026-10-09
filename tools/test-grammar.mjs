// Hold the grammar to the scopes it produced when they were last looked at.
//
//   ./tools/tm tools/test-grammar.mjs            # compare
//   ./tools/tm tools/test-grammar.mjs --update   # re-record, after a deliberate change
//
// Every fixture under test/ is tokenised with the real engine and compared with the
// .scopes file beside it, which turns the "regression cases" there into regressions a
// run can actually fail on.
//
// Only the scopes this extension's grammars assign are recorded, merged over each run of
// text that carries the same ones. So the record is a function of what TikZ highlighting
// looks like, not of how the stock LaTeX grammar happens to split its tokens -- which
// matters, since CI runs this against whatever VS Code shipped last night. A host change
// still shows up wherever it changes our scopes: renaming the tikzpicture scope the
// injection keys on would empty every record, as it would empty every picture.

import fs from "node:fs";
import path from "node:path";
import { INITIAL, REPO, VSCODE_BUILD, grammarFor, ourScopes, registry } from "./engine.mjs";

const update = process.argv.includes("--update");
const TEST = path.join(REPO, "test");
const OURS = ourScopes();
const reg = registry();

/** Fixtures directly under test/; subfolders hold inputs for other checks. */
function fixtures() {
    return fs
        .readdirSync(TEST)
        .filter((name) => /\.(tex|tikz)$/.test(name))
        .sort()
        .map((name) => path.join(TEST, name));
}

/** The record for one file: each line, then the runs of text on it that carry our scopes. */
async function record(file) {
    const grammar = await grammarFor(reg, file);
    const out = [];
    let stack = INITIAL;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((line, index) => {
        const result = grammar.tokenizeLine(line, stack);
        stack = result.ruleStack;
        out.push(`${String(index + 1).padStart(4)}  ${line}`.trimEnd());

        const runs = [];
        for (const t of result.tokens) {
            const scopes = t.scopes.filter((s) => OURS.has(s)).join(" ");
            const piece = line.slice(t.startIndex, t.endIndex);
            const last = runs.at(-1);
            if (last && last.scopes === scopes) last.text += piece;
            else runs.push({ text: piece, scopes });
        }
        for (const run of runs) {
            if (!run.scopes || !run.text.trim()) continue;
            out.push(`        ${JSON.stringify(run.text).padEnd(24)} ${run.scopes}`);
        }
    });
    return out.join("\n") + "\n";
}

/** A line diff, minimal by longest common subsequence; fixtures are a few dozen lines. */
function diff(expected, actual) {
    const a = expected.split("\n");
    const b = actual.split("\n");
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    // Each change is shown under the source line it belongs to, which is the line of the
    // record above it that is not indented.
    const lines = [];
    let context = "";
    let shown = "";
    const emit = (change) => {
        if (context !== shown) lines.push(`    ${context}`);
        shown = context;
        lines.push(change);
    };
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            if (!a[i].startsWith(" ".repeat(8))) context = a[i];
            i++;
            j++;
        } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
            emit(`  + ${b[j++]}`);
        } else {
            emit(`  - ${a[i++]}`);
        }
    }
    return lines.join("\n");
}

let failed = 0;
const recorded = new Set();
for (const file of fixtures()) {
    const scopesFile = `${file}.scopes`;
    recorded.add(path.basename(scopesFile));
    const actual = await record(file);
    const name = path.relative(REPO, file);
    if (update) {
        fs.writeFileSync(scopesFile, actual);
        continue;
    }
    if (!fs.existsSync(scopesFile)) {
        failed++;
        console.error(`FAIL ${name}: no ${path.basename(scopesFile)} recorded`);
        continue;
    }
    const expected = fs.readFileSync(scopesFile, "utf8");
    if (expected !== actual) {
        failed++;
        console.error(`FAIL ${name} no longer tokenises as recorded (- recorded, + now):\n${diff(expected, actual)}`);
    }
}

for (const name of fs.readdirSync(TEST).filter((n) => n.endsWith(".scopes"))) {
    if (recorded.has(name)) continue;
    if (update) {
        fs.rmSync(path.join(TEST, name));
    } else {
        failed++;
        console.error(`FAIL test/${name} records a fixture that no longer exists`);
    }
}

if (update) {
    console.log(`recorded ${recorded.size} fixtures on ${VSCODE_BUILD}`);
} else if (failed) {
    console.error(
        `\n${failed} grammar fixture(s) differ, on ${VSCODE_BUILD}. ` +
            "If the change is intended, re-record: ./tools/tm tools/test-grammar.mjs --update"
    );
    process.exit(1);
} else {
    console.log(`ok: ${recorded.size} grammar fixtures on ${VSCODE_BUILD}`);
}
