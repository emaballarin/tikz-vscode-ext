// Does a theme actually have a colour for the scopes this grammar uses?
//
//   ./tools/tm tools/theme-check.mjs             # the theme you are using, in that VS Code
//   ./tools/tm tools/theme-check.mjs <theme.json>...
//
// Mapping TikZ onto conventional scopes is only worth anything if themes really style
// those scopes. This asks the editor's own matcher -- vscode-textmate, out of the VS Code
// tools/tm runs, with the theme set on it -- what colour each kind of token gets, and
// reports which come out the colour of the text around them.
//
// It used to work the colour out itself, and each rule it got wrong was another way to
// misreport: the deepest matching scope deciding, ancestor parts ("a b"), the child
// combinator ("a > b"), the order between rules of equal weight, a rule setting only a
// font style. Asking the matcher that paints the editor leaves nothing to get wrong there.

import fs from "node:fs";
import path from "node:path";
import { INITIAL, onigLib, textmate } from "./engine.mjs";
import { findVSCode } from "./vscode.mjs";

// The scope stack our grammar puts on each kind of token, outermost first. A space-separated
// `name` in a grammar is a nested stack, not a list of alternatives.
const SCOPES = [
    ["option key", "entity.other.attribute-name.tikz", "variable.other.property.tikz"],
    ["assignment", "keyword.operator.assignment.tikz"],
    ["arrow tip", "keyword.operator.arrow.tikz"],
    ["path join", "keyword.operator.path.tikz"],
    ["dimension", "constant.numeric.dimension.tikz"],
    ["unit", "constant.numeric.dimension.tikz", "keyword.other.unit.tikz"],
    ["bare option", "support.function.tikz", "entity.name.function.tikz"],
    ["path operator", "keyword.control.path.tikz"],
    ["coordinate", "variable.other.coordinate.tikz"],
    ["colour", "support.constant.color.tikz", "constant.language.tikz", "variable.other.constant.tikz"],
    ["style name", "entity.name.function.style.tikz", "entity.name.function.tikz"],
    ["style handle", "keyword.other.handler.tikz"],
    ["maths", "string.other.math.tikz"],
];

// The scopes the semantic provider's token types fall back to (semanticTokenScopes). A
// semantic token is matched by that one scope, with no stack around it, so these are
// asked about alone. The editor resolves them in its own theme service rather than in
// vscode-textmate; for a single scope the two agree.
const SEMANTIC = [
    ["macro (semantic)", "variable.other.tikz"],
    ["style (semantic)", "entity.name.type.tikz"],
];

// Where a TikZ token sits: a LaTeX document, inside a tikzpicture. Ordinary text in the
// picture -- node text -- has these scopes alone, and its colour is what "plain" means
// here, which is not always the editor foreground: a theme colouring bare `meta` gives the
// whole picture a colour of its own.
const ROOT = "text.tex.latex";
const PICTURE = "meta.function.environment.latex.tikz";

// Themes are JSONC. A line-based comment strip is not enough -- VS Code's own themes
// carry trailing // comments inside arrays, and a URL in a string looks exactly like the
// start of one -- so this walks the text and skips over string literals.
function strip(text) {
    let out = "";
    for (let i = 0; i < text.length;) {
        const c = text[i];
        if (c === '"') {
            // Step over each escape whole, so a string ending in \\ still ends.
            let j = i + 1;
            while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
        } else if (c === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i += 2;
        } else {
            out += c;
            i++;
        }
    }
    return out.replace(/,(\s*[}\]])/g, "$1");
}

// VS Code's own themes are built as chains: dark_modern includes dark_plus includes
// dark_vs. A checker that stops at the first file calls every scope unstyled.
function load(file, seen = new Set()) {
    const full = path.resolve(file);
    if (seen.has(full)) return { tokenColors: [] };
    seen.add(full);

    const theme = JSON.parse(strip(fs.readFileSync(full, "utf8")));
    // tokenColors may name a file instead of listing the rules. A JSON one is read; a
    // .tmTheme is a plist, which this does not read, and is said so rather than taken as
    // a theme with no rules.
    if (typeof theme.tokenColors === "string") {
        const rules = path.join(path.dirname(full), theme.tokenColors);
        if (!rules.endsWith(".json")) bail(`${file} keeps its rules in ${theme.tokenColors}, which is not JSON`);
        const read = JSON.parse(strip(fs.readFileSync(rules, "utf8")));
        theme.tokenColors = Array.isArray(read) ? read : (read.tokenColors ?? []);
    }
    if (!theme.include) return theme;

    const base = load(path.join(path.dirname(full), theme.include), seen);
    // Later rules win, so the including theme's own rules go last.
    return {
        ...theme,
        colors: { ...(base.colors ?? {}), ...(theme.colors ?? {}) },
        tokenColors: [...(base.tokenColors ?? []), ...(theme.tokenColors ?? [])],
    };
}

// A rule that matches is not the same as a colour you can see. Monokai styles bare
// `variable` as #F8F8F2, which is its editor foreground, so a scope resolving through it
// reads as ordinary text -- the failure this whole table exists to prevent, and the one a
// match/no-match check walks straight past. Alpha is dropped: it does not make text stand out.
const colour = (c) => (c ?? "").slice(0, 7).toLowerCase();

/**
 * The colour of each kind of token in `rows`, and of plain text around them, as the
 * editor's matcher gives them under `theme`. Each row becomes a word in a generated
 * grammar whose rule names that row's scopes, so the word is tokenised with exactly the
 * stack it would have in a figure; a last word, "base", has the surroundings alone.
 */
async function colours(theme, rows, root, around) {
    const grammar = {
        scopeName: root,
        patterns: [
            ...rows.map(([, ...scopes], i) => ({ match: `\\bk${i}\\b`, name: [...around, ...scopes].join(" ") })),
            ...(around.length ? [{ match: "\\bbase\\b", name: around.join(" ") }] : []),
        ],
    };
    const registry = new textmate.Registry({
        onigLib,
        loadGrammar: async (scopeName) =>
            scopeName === root ? textmate.parseRawGrammar(JSON.stringify(grammar), "probe.json") : null,
        theme,
    });
    const words = [...rows.map((_, i) => `k${i}`), "base"];
    const line = words.join(" ");
    const loaded = await registry.loadGrammar(root);
    const { tokens } = loaded.tokenizeLine2(line, INITIAL);
    const map = registry.getColorMap();
    // Binary tokens merge neighbours of equal metadata, so a word painted like the space
    // before it has no entry of its own: its colour is that of the last token starting at
    // or before it. The foreground's index into the colour map is bits 15-23.
    const colourAt = (offset) => {
        let metadata = tokens[1];
        for (let i = 0; i < tokens.length && tokens[i] <= offset; i += 2) metadata = tokens[i + 1];
        return colour(map[(metadata & 0xff8000) >>> 15]);
    };
    let offset = 0;
    const found = words.map((word) => {
        const c = colourAt(offset);
        offset += word.length + 1;
        return c;
    });
    return { rows: found.slice(0, -1), base: found.at(-1) };
}

/** A theme as vscode-textmate takes it: the editor's colours first, then the rules. */
function rawTheme(theme) {
    const colors = theme.colors ?? {};
    return {
        name: theme.name ?? "theme",
        settings: [
            { settings: { foreground: colors["editor.foreground"], background: colors["editor.background"] } },
            ...(theme.tokenColors ?? []),
        ],
    };
}

/**
 * The theme named in the user's settings, as a file. Given no argument, the question
 * being asked is almost always "what about the theme I am looking at right now", and
 * making someone find their theme's JSON by hand is how a checker goes unrun.
 * @returns {string[]}
 */
function currentTheme() {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    // Under tools/tm the running VS Code says where its own settings and extensions live:
    // Insiders keeps them under "Code - Insiders" and ~/.vscode-insiders, not Code and
    // ~/.vscode. Under a plain node, assume Stable.
    const vscode = findVSCode();
    const folder = vscode?.product.nameShort ?? "Code";
    const settings =
        {
            darwin: path.join(home, "Library/Application Support", folder, "User/settings.json"),
            win32: path.join(process.env.APPDATA ?? "", folder, "User/settings.json"),
        }[process.platform] ?? path.join(home, ".config", folder, "User/settings.json");

    let label;
    try {
        label = JSON.parse(strip(fs.readFileSync(settings, "utf8")))["workbench.colorTheme"];
    } catch {
        bail(`could not read ${settings}. Name a theme file instead.`);
    }
    if (!label) bail("no workbench.colorTheme in your settings. Name a theme file instead.");

    // A theme is contributed by an extension, under a label that need not resemble the
    // file name -- "Aether Neptune" lives in aether-neptune.json, but "Default Dark+"
    // lives in dark_plus.json. The manifests are the only mapping there is.
    const roots = [
        path.join(home, vscode?.product.dataFolderName ?? ".vscode", "extensions"),
        vscode ?
            path.join(vscode.app, "extensions")
        :   ({
                darwin: "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
                win32: path.join(process.env.LOCALAPPDATA ?? "", "Programs/Microsoft VS Code/resources/app/extensions"),
            }[process.platform] ?? "/usr/share/code/resources/app/extensions"),
    ];

    for (const root of roots) {
        let entries = [];
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const manifest = path.join(root, entry, "package.json");
            let contributed;
            try {
                contributed = JSON.parse(strip(fs.readFileSync(manifest, "utf8")))?.contributes?.themes ?? [];
            } catch {
                continue;
            }
            for (const theme of contributed) {
                if (theme.label === label || theme.id === label) {
                    console.log(`\x1b[2m${label}\x1b[0m`);
                    return [path.join(root, entry, theme.path)];
                }
            }
        }
    }
    bail(`could not find the theme "${label}" among the installed extensions. Name its file instead.`);
}

function bail(message) {
    console.error(`theme-check: ${message}`);
    process.exit(1);
}

const files = process.argv.length > 2 ? process.argv.slice(2) : currentTheme();

if (!findVSCode()) bail("run this through tools/tm, which lends it VS Code's own matcher");

for (const file of files) {
    const theme = rawTheme(load(file));
    const picture = await colours(theme, SCOPES, ROOT, [PICTURE]);
    const semantic = await colours(theme, SEMANTIC, "probe.semantic", []);
    const resolved = [
        ...SCOPES.map(([label], i) => [label, picture.rows[i], picture.base]),
        ...SEMANTIC.map(([label], i) => [label, semantic.rows[i], semantic.base]),
    ];
    const missing = resolved.filter(([, c, base]) => c === base);
    const styled = new Set(resolved.filter(([, c, base]) => c !== base).map(([, c]) => c));
    const tag = missing.length ? `\x1b[33m${missing.length} as plain text\x1b[0m` : "\x1b[32mall styled\x1b[0m";
    console.log(`${path.basename(file).padEnd(34)} ${String(styled.size).padStart(2)} distinct colours, ${tag}`);
    for (const [label, c] of missing) {
        console.log(`    \x1b[33m- ${label} (${c}, as plain text)\x1b[0m`);
    }
}
