"use strict";

const vscode = require("vscode");
const { StyleIndex } = require("./styleIndex");
const { TikzSemanticTokensProvider } = require("./semantic");
const { runBuildAndReport, viewAndReport } = require("./build");

const LANGUAGES = ["latex", "tex", "tikz"];

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
    const styleIndex = new StyleIndex();
    const provider = new TikzSemanticTokensProvider(styleIndex);

    context.subscriptions.push(styleIndex, provider);
    for (const language of LANGUAGES) {
        context.subscriptions.push(
            vscode.languages.registerDocumentSemanticTokensProvider(
                { language, scheme: "file" },
                provider,
                TikzSemanticTokensProvider.legend
            )
        );
    }

    context.subscriptions.push(vscode.commands.registerCommand("tikz.build", () => runBuildAndReport(context)));

    context.subscriptions.push(vscode.commands.registerCommand("tikz.view", viewAndReport));

    context.subscriptions.push(
        vscode.commands.registerCommand("tikz.rebuildStyleIndex", async () => {
            await styleIndex.refreshAll();
            vscode.window.showInformationMessage(`TikZ: indexed ${styleIndex.names.size} styles.`);
        })
    );

    // Indexing the workspace must not hold up activation.
    styleIndex.start().catch((err) => {
        console.error("TikZ: style index failed to start", err);
    });
}

function deactivate() {}

module.exports = { activate, deactivate };
