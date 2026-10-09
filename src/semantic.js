"use strict";

const vscode = require("vscode");
const {
    MACRO_USE,
    collectMacroDefinitions,
    collectStyleDefinitions,
    optionRegions,
    optionItemNames,
} = require("./symbols");

const TOKEN_TYPES = ["tikzMacro", "tikzStyle"];
const TOKEN_MODIFIERS = ["declaration"];

const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

/**
 * Highlights what a TextMate grammar structurally cannot: symbols whose meaning depends
 * on a definition elsewhere in the file, or elsewhere in the workspace.
 *
 * - `tikzMacro` — a control sequence this file defines with \def and friends. Scoped to
 *   the file on purpose: that is what \def means.
 * - `tikzStyle` — a pgfkeys style, resolved against the workspace index so that a figure
 *   fragment shows the styles its preamble defines.
 */
class TikzSemanticTokensProvider {
    /** @param {import('./styleIndex').StyleIndex} styleIndex */
    constructor(styleIndex) {
        this._styleIndex = styleIndex;
        this._onDidChangeSemanticTokens = new vscode.EventEmitter();
        this.onDidChangeSemanticTokens = this._onDidChangeSemanticTokens.event;

        /** @type {{uri: string, version: number, tokens: vscode.SemanticTokens} | null} */
        this._cache = null;

        // A new style in the preamble changes how every open figure file should look. The
        // cache is keyed on the document alone, so it has to go too, or the refresh asked
        // for here is answered with the tokens from before the change.
        styleIndex.onDidChange(() => {
            this._cache = null;
            this._onDidChangeSemanticTokens.fire();
        });
    }

    static get legend() {
        return LEGEND;
    }

    /**
     * @param {vscode.TextDocument} document
     * @returns {vscode.SemanticTokens}
     */
    provideDocumentSemanticTokens(document) {
        const key = document.uri.toString();
        if (this._cache && this._cache.uri === key && this._cache.version === document.version) {
            return this._cache.tokens;
        }

        const text = document.getText();

        /** @type {Array<{start: number, length: number, type: string, modifiers: string[]}>} */
        const found = [];
        this._markMacros(text, found);
        this._markStyles(text, found);

        // The builder encodes each token as a delta from the previous one, so they have to
        // go in document order. Macros and styles are gathered independently, so sort.
        found.sort((a, b) => a.start - b.start);

        const builder = new vscode.SemanticTokensBuilder(LEGEND);
        for (const t of found) {
            builder.push(
                new vscode.Range(document.positionAt(t.start), document.positionAt(t.start + t.length)),
                t.type,
                t.modifiers
            );
        }

        const tokens = builder.build();
        this._cache = { uri: key, version: document.version, tokens };
        return tokens;
    }

    /**
     * @param {string} text
     * @param {Array<{start: number, length: number, type: string, modifiers: string[]}>} out
     */
    _markMacros(text, out) {
        const defined = collectMacroDefinitions(text);
        if (defined.size === 0) return;

        MACRO_USE.lastIndex = 0;
        let m;
        while ((m = MACRO_USE.exec(text)) !== null) {
            const name = m[1];
            const definedAt = defined.get(name);
            if (definedAt === undefined) continue;

            // Cover the backslash too, so the whole control sequence reads as one symbol.
            out.push({
                start: m.index,
                length: 1 + name.length,
                type: "tikzMacro",
                modifiers: definedAt === m.index + 1 ? ["declaration"] : [],
            });
        }
    }

    /**
     * @param {string} text
     * @param {Array<{start: number, length: number, type: string, modifiers: string[]}>} out
     */
    _markStyles(text, out) {
        const known = this._styleIndex.names;
        const localDefinitions = collectStyleDefinitions(text);
        if (known.size === 0 && localDefinitions.size === 0) return;

        for (const region of optionRegions(text)) {
            for (const item of optionItemNames(text, region)) {
                // A definition reads `name/.style`; a reference is the bare name.
                const bare = item.name.replace(/\s*\/\..*$/, "").trim();
                if (!bare) continue;
                if (!known.has(bare) && !localDefinitions.has(bare)) continue;

                // `name=value` is a key being set, not a style being applied. The exception is
                // the definition itself, which is written `name/.style = {...}`.
                const isDeclaration = localDefinitions.get(bare) === item.start;
                if (item.hasValue && !isDeclaration) continue;

                out.push({
                    start: item.start,
                    length: bare.length,
                    type: "tikzStyle",
                    modifiers: isDeclaration ? ["declaration"] : [],
                });
            }
        }
    }

    dispose() {
        this._onDidChangeSemanticTokens.dispose();
    }
}

module.exports = { TikzSemanticTokensProvider };
