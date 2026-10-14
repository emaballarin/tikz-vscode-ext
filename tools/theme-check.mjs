// Does a theme actually have a colour for the scopes this grammar uses?
//
//   ./tools/tm tools/theme-check.mjs             # the theme you are using, in that VS Code
//   ./tools/tm tools/theme-check.mjs <theme.json>...
//
// Mapping TikZ onto conventional scopes is only worth anything if themes really style
// those scopes. This resolves each token the way the editor does -- see resolve() -- and
// reports which fall through to the default foreground.

import fs from "node:fs";
import path from "node:path";
import { findVSCode } from "./vscode.mjs";

// Each entry is the full scope stack the grammar puts on one kind of token, outermost
// first. A space-separated `name` in a grammar is a nested stack, not a list of
// alternatives, and the editor themes the DEEPEST scope that any rule matches -- so the
// last entry here wins wherever the theme has a rule for it, and the ones before it are
// consulted only when it does not. Getting that backwards is how this reported Monokai
// as styling the option key when the editor was painting it as plain text.
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
    ["macro (semantic)", "variable.other.tikz"],
    ["style (semantic)", "entity.name.type.tikz"],
];

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

// The scopes every token in a picture sits inside, outermost first. A rule written
// "a b" applies to b only with a among its ancestors, and these are the ancestors a TikZ
// token has. A semantic token is matched by its mapped scope alone, with none.
const PICTURE = ["text.tex.latex", "meta.function.environment.latex.tikz"];

const prefixOf = (selector, scope) => scope === selector || scope.startsWith(selector + ".");

/** Lexicographic order of two rankings of the same length. */
const compare = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
};

/**
 * Whether a selector, split into its parts, matches the scope at `depth` of `path`: the
 * last part that scope, and each part before it some scope further out, in order.
 */
function matchesAt(parts, path, depth) {
    if (!prefixOf(parts.at(-1), path[depth])) return false;
    let outer = depth - 1;
    for (let k = parts.length - 2; k >= 0; k--) {
        while (outer >= 0 && !prefixOf(parts[k], path[outer])) outer--;
        if (outer < 0) return false;
        outer--;
    }
    return true;
}

/**
 * The colour a theme gives the token whose scopes are `path`, outermost first, or null.
 *
 * The deepest scope any rule matches decides, and outer ones are consulted only when it
 * has none -- getting that backwards is how this once reported Monokai as styling the
 * option key while the editor painted it plain. Among the rules matching one scope the
 * longer selector wins, then the one with more ancestors, then the later: load() puts an
 * including theme's rules after its base's for exactly that reason. A selector with an
 * exclusion ("a - b") is not modelled, and such a rule is left out rather than half-read.
 * @param {{tokenColors?: Array<any>}} theme
 * @param {string[]} path
 */
function resolve(theme, path) {
    for (let depth = path.length - 1; depth >= 0; depth--) {
        let best = null;
        let rank = null;
        (theme.tokenColors ?? []).forEach((rule, index) => {
            if (!rule.settings?.foreground) return;
            let selectors = rule.scope ?? [];
            if (typeof selectors === "string") selectors = selectors.split(",");
            for (const raw of selectors) {
                if (/(^|\s)-/.test(raw.trim())) continue;
                const parts = raw.replace(/>/g, " ").trim().split(/\s+/).filter(Boolean);
                if (!parts.length || !matchesAt(parts, path, depth)) continue;
                const candidate = [parts.at(-1).split(".").length, parts.length - 1, index];
                if (!rank || compare(candidate, rank) > 0) {
                    best = rule.settings.foreground;
                    rank = candidate;
                }
            }
        });
        if (best) return best;
    }
    return null;
}

// VS Code's own themes are built as chains: dark_modern includes dark_plus includes
// dark_vs. A checker that stops at the first file calls every scope unstyled.
function load(file, seen = new Set()) {
    const full = path.resolve(file);
    if (seen.has(full)) return { tokenColors: [] };
    seen.add(full);

    const theme = JSON.parse(strip(fs.readFileSync(full, "utf8")));
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
// match/no-match check walks straight past.
const same = (a, b) => a && b && a.slice(0, 7).toLowerCase() === b.slice(0, 7).toLowerCase();

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

for (const file of files) {
    const theme = load(file);
    const foreground = theme.colors?.["editor.foreground"];
    const resolved = SCOPES.map(([label, ...scopes]) => [
        label,
        resolve(theme, label.endsWith("(semantic)") ? scopes : [...PICTURE, ...scopes]),
    ]);
    const missing = resolved.filter(([, c]) => !c || same(c, foreground));
    const colours = new Set(resolved.map(([, c]) => c).filter((c) => c && !same(c, foreground)));
    const tag = missing.length ? `\x1b[33m${missing.length} as plain text\x1b[0m` : "\x1b[32mall styled\x1b[0m";
    console.log(`${path.basename(file).padEnd(34)} ${String(colours.size).padStart(2)} distinct colours, ${tag}`);
    for (const [label, colour] of missing) {
        console.log(`    \x1b[33m- ${label}${colour ? ` (${colour}, the foreground)` : " (no rule)"}\x1b[0m`);
    }
}
