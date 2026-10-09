"use strict";

// The pattern vocabulary shared by the semantic provider and the workspace index.
// Everything here is a plain regex over document text: TikZ has no parser worth writing
// for this purpose, and the constructs we care about are all lexically distinctive.

/**
 * Ways a control sequence gets defined. Each expression captures the bare name (no
 * backslash) in group 1.
 */
const MACRO_DEFINITIONS = [
    // \def\name, \gdef\name, \edef\name, \xdef\name
    /\\[egx]?def\s*\\([A-Za-z@]+)/g,
    // \newcommand{\name}, \renewcommand*{\name}, \providecommand{\name}
    /\\(?:new|renew|provide)command\*?\s*\{\s*\\([A-Za-z@]+)\s*\}/g,
    // \newcommand\name (braceless form)
    /\\(?:new|renew|provide)command\*?\s*\\([A-Za-z@]+)/g,
    // \let\name
    /\\let\s*\\([A-Za-z@]+)/g,
    // \pgfmathsetmacro{\name} and \pgfmathsetlengthmacro{\name}
    /\\pgfmathset(?:length)?macro\s*\{\s*\\([A-Za-z@]+)\s*\}/g,
];

/**
 * A pgfkeys style definition: `name/.style = {...}` and its many siblings. Anchored to
 * the start of a key list item so a stray slash mid-line cannot invent a style name.
 */
const STYLE_DEFINITION =
    /(?:^|[{,[])\s*([A-Za-z@][A-Za-z0-9@ ._+-]*?)\s*\/\.(?:style\s+\d+\s+args|style\s+n\s+args|append\s+style|prefix\s+style|style|code\s+\d+\s+args|code|default|initial|estore\s+in|store\s+in|is\s+choice|list|add|forward\s+to|search\s+also)\b/gm;

/** Every use of a control sequence, captured without its backslash. */
const MACRO_USE = /\\([A-Za-z@]+)/g;

/**
 * Collect the macros this text defines.
 * @param {string} text
 * @returns {Map<string, number>} name -> offset of the defining occurrence
 */
function collectMacroDefinitions(text) {
    const found = new Map();
    for (const pattern of MACRO_DEFINITIONS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            // The offset of the name itself, not of the defining command.
            const at = m.index + m[0].lastIndexOf(m[1]);
            if (!found.has(m[1])) found.set(m[1], at);
        }
    }
    return found;
}

/**
 * Collect the pgfkeys styles this text defines.
 * @param {string} text
 * @returns {Map<string, number>} name -> offset of the defining occurrence
 */
function collectStyleDefinitions(text) {
    const found = new Map();
    STYLE_DEFINITION.lastIndex = 0;
    let m;
    while ((m = STYLE_DEFINITION.exec(text)) !== null) {
        const at = m.index + m[0].lastIndexOf(m[1]);
        if (!found.has(m[1])) found.set(m[1], at);
    }
    return found;
}

const KEYSET_COMMAND =
    /^\\(?:tikzset|pgfplotsset|pgfkeys|pgfqkeys|tikzstyle|pgfplotscreateplotcyclelist)(?![A-Za-z@])\s*\{/;

/** Advance past a line comment. */
function pastComment(text, i) {
    while (i < text.length && text[i] !== "\n") i++;
    return i;
}

/** Index just past `closer`, or end of text if it never arrives. */
function pastDelimiter(text, from, closer) {
    const at = text.indexOf(closer, from);
    return at === -1 ? text.length : at + closer.length;
}

/**
 * Index just past the delimiter matching the one at `open`, honouring nesting, escapes
 * and comments. Returns -1 if it is never closed.
 */
function matchDelimiter(text, open, opener, closer) {
    let depth = 1;
    for (let i = open + 1; i < text.length; i++) {
        const c = text[i];
        if (c === "\\") {
            i++;
            continue;
        }
        if (c === "%") {
            i = pastComment(text, i);
            continue;
        }
        if (c === opener) depth++;
        else if (c === closer && --depth === 0) return i;
    }
    return -1;
}

/** Push a region and, recursively, the braced values nested inside it. */
function pushRegion(text, start, end, regions) {
    regions.push({ start, end });
    for (let i = start; i < end; i++) {
        const c = text[i];
        if (c === "\\") {
            i++;
            continue;
        }
        if (c === "%") {
            i = pastComment(text, i);
            continue;
        }
        if (c !== "{") continue;
        const close = matchDelimiter(text, i, "{", "}");
        if (close === -1 || close > end) break;
        pushRegion(text, i + 1, close, regions);
        i = close;
    }
}

/**
 * Yield the regions of a document in which a bare word may be a TikZ style reference.
 *
 * The gating is the whole point. Style names are ordinary short words — this corpus
 * defines styles called `n`, `a`, `b`, `p` and `x` — so a scan of every `[...]` in the
 * file lights up array subscripts like `\vx[n]` in maths and in code listings. Only
 * three contexts count: inside a tikzpicture, inside an inline `\tikz...;`, and inside a
 * `\tikzset{...}` block. Maths is skipped even within those, mirroring the -meta.math
 * exclusion the grammar relies on.
 *
 * @param {string} text
 * @returns {Array<{start: number, end: number}>}
 */
function optionRegions(text) {
    const regions = [];
    const n = text.length;

    let pictureDepth = 0;
    let inlineEnd = -1; // where the current inline \tikz...; stops counting as a picture
    let i = 0;

    while (i < n) {
        if (inlineEnd !== -1 && i > inlineEnd) inlineEnd = -1;
        const inTikz = pictureDepth > 0 || inlineEnd !== -1;
        const c = text[i];

        if (c === "%") {
            i = pastComment(text, i);
            continue;
        }

        if (c === "$") {
            // $...$ and $$...$$ are maths and never contain options.
            const closer = text.startsWith("$$", i) ? "$$" : "$";
            i = pastDelimiter(text, i + closer.length, closer);
            continue;
        }

        if (c === "\\") {
            if (text.startsWith("\\begin{tikzpicture}", i)) {
                pictureDepth++;
                i += 19;
                continue;
            }
            if (text.startsWith("\\end{tikzpicture}", i)) {
                pictureDepth = Math.max(0, pictureDepth - 1);
                i += 17;
                continue;
            }
            if (text.startsWith("\\(", i)) {
                i = pastDelimiter(text, i + 2, "\\)");
                continue;
            }
            if (text.startsWith("\\[", i)) {
                i = pastDelimiter(text, i + 2, "\\]");
                continue;
            }

            const keyset = KEYSET_COMMAND.exec(text.slice(i, i + 40));
            if (keyset) {
                const open = i + keyset[0].length - 1;
                const close = matchDelimiter(text, open, "{", "}");
                if (close !== -1) pushRegion(text, open + 1, close, regions);
                i = close === -1 ? n : close + 1;
                continue;
            }

            // An inline \tikz...; behaves as a one-line picture.
            if (/^\\tikz(?![A-Za-z@])/.test(text.slice(i, i + 6))) {
                const semi = text.indexOf(";", i);
                inlineEnd = semi === -1 ? n : semi;
                i += 5;
                continue;
            }

            i += 2; // skip the escaped character
            continue;
        }

        if (c === "[" && inTikz) {
            const close = matchDelimiter(text, i, "[", "]");
            if (close !== -1) {
                pushRegion(text, i + 1, close, regions);
                i = close + 1;
                continue;
            }
        }

        i++;
    }

    return regions;
}

/**
 * Split an option region into items and return the leading name of each, so that both
 * `school axis` and `every node/.style={...}` surrender the name `school axis` /
 * `every node`. Nested braces and brackets are skipped over, not descended into; the
 * caller re-scans them as their own regions.
 *
 * `hasValue` records whether the item was written as `name=...`, which tells a style
 * reference (`[thick, neuron]`) apart from a key that merely shares its name with one
 * (`table [x=xc]`, where `x` is a pgfplots key and not the `x/.style` of this workspace).
 *
 * @param {string} text
 * @param {{start: number, end: number}} region
 * @returns {Array<{name: string, start: number, hasValue: boolean}>}
 */
function optionItemNames(text, region) {
    const items = [];
    let i = region.start;

    while (i < region.end) {
        // Skip leading separators, whitespace and comments. Comments matter: a style
        // definition preceded by a comment line would otherwise start its name at the '%'
        // and swallow the comment, so the name never matches the index and the definition
        // silently goes unhighlighted.
        for (;;) {
            while (i < region.end && /[\s,]/.test(text[i])) i++;
            if (i < region.end && text[i] === "%") {
                i = pastComment(text, i);
                continue;
            }
            break;
        }
        if (i >= region.end) break;

        const start = i;
        let depth = 0;
        let stop = i;
        for (; i < region.end; i++) {
            const c = text[i];
            if (c === "\\") {
                i++;
                continue;
            }
            if (c === "%") {
                while (i < region.end && text[i] !== "\n") i++;
                continue;
            }
            if (c === "{" || c === "[") depth++;
            else if (c === "}" || c === "]") depth--;
            else if (depth === 0 && (c === "," || c === "=")) break;
            if (depth === 0) stop = i + 1;
        }

        const raw = text.slice(start, stop);
        const name = raw.trim();
        const hasValue = i < region.end && text[i] === "=";
        if (name) items.push({ name, start: start + raw.indexOf(name), hasValue });

        // If we stopped at '=', run to the end of this item before continuing.
        if (hasValue) {
            let depth2 = 0;
            for (; i < region.end; i++) {
                const c = text[i];
                if (c === "\\") {
                    i++;
                    continue;
                }
                if (c === "%") {
                    while (i < region.end && text[i] !== "\n") i++;
                    continue;
                }
                if (c === "{" || c === "[") depth2++;
                else if (c === "}" || c === "]") depth2--;
                else if (depth2 === 0 && c === ",") break;
            }
        }
        i++;
    }

    return items;
}

module.exports = {
    MACRO_USE,
    collectMacroDefinitions,
    collectStyleDefinitions,
    optionRegions,
    optionItemNames,
};
