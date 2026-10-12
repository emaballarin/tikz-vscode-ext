"use strict";

const vscode = require("vscode");
const { collectStyleDefinitions } = require("./symbols");

const SOURCE_GLOB = "**/*.{tex,sty,cls,tikz}";
const MAX_FILES = 4000;

/**
 * A workspace-wide index of pgfkeys style names.
 *
 * A figure file is typically a twenty-line fragment whose every meaningful option comes
 * from a preamble it does not itself contain. Indexing the workspace is what lets those
 * fragments light up at all; a current-file-only rule would find almost nothing in them.
 */
class StyleIndex {
    constructor() {
        /** @type {Map<string, Map<string, number>>} file path -> (style name -> offset) */
        this._byFile = new Map();
        /** @type {Set<string>} */
        this._names = new Set();
        this._onDidChange = new vscode.EventEmitter();
        /** Fires when the set of known style names changes. */
        this.onDidChange = this._onDidChange.event;
        this._watcher = undefined;
        this._saveListener = undefined;
        /** @type {Set<Set<string>>} for each rebuild running, the files touched since it began */
        this._rebuilds = new Set();
    }

    /** @returns {Set<string>} every style name currently known */
    get names() {
        return this._names;
    }

    /**
     * Where a style is defined, for go-to-definition later on.
     * @param {string} name
     * @returns {{path: string, offset: number} | undefined}
     */
    locate(name) {
        for (const [path, styles] of this._byFile) {
            const offset = styles.get(name);
            if (offset !== undefined) return { path, offset };
        }
        return undefined;
    }

    async start() {
        await this.refreshAll();

        this._watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
        this._watcher.onDidCreate((uri) => this.refreshFile(uri));
        this._watcher.onDidChange((uri) => this.refreshFile(uri));
        this._watcher.onDidDelete((uri) => {
            if (this._byFile.delete(uri.fsPath)) this._rebuildNames();
        });

        // The watcher does not fire for an unsaved buffer, so pick up edits on save too.
        this._saveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (/\.(tex|sty|cls|tikz)$/.test(doc.fileName)) {
                this._ingest(doc.fileName, doc.getText());
            }
        });
    }

    /**
     * Re-scan the workspace. Every file the scan does not list is dropped first: reading
     * into the map alone kept every file it had ever seen, so one gone without a watcher
     * event -- VS Code may report a deleted folder and not the files in it -- stayed in the
     * index through Rebuild, the command that exists to recover from exactly that. Pruning
     * in place, rather than swapping in a fresh map, keeps a save that lands while the files
     * are being read; one that lands while the scan itself runs is not on its list, and is
     * spared by having been touched since the rebuild began.
     */
    async refreshAll() {
        // One set per rebuild, so two that overlap -- the activation scan and a Rebuild
        // pressed while it runs -- each keep their own and neither clears the other's.
        const touched = new Set();
        this._rebuilds.add(touched);
        try {
            const uris = await vscode.workspace.findFiles(SOURCE_GLOB, "**/node_modules/**", MAX_FILES);
            const listed = new Set(uris.map((uri) => uri.fsPath));
            for (const file of [...this._byFile.keys()]) {
                if (!listed.has(file) && !touched.has(file)) this._byFile.delete(file);
            }
            await Promise.all(uris.map((uri) => this._read(uri)));
        } finally {
            this._rebuilds.delete(touched);
        }
        this._rebuildNames();
    }

    /** Mark a file as touched for every rebuild running, which must not prune it. */
    _touch(path) {
        for (const touched of this._rebuilds) touched.add(path);
    }

    /** @param {vscode.Uri} uri */
    async refreshFile(uri) {
        this._touch(uri.fsPath);
        await this._read(uri);
        this._rebuildNames();
    }

    /** @param {vscode.Uri} uri */
    async _read(uri) {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            this._byFile.set(uri.fsPath, collectStyleDefinitions(Buffer.from(bytes).toString("utf8")));
        } catch {
            // A file that vanished or cannot be read simply contributes nothing.
            this._byFile.delete(uri.fsPath);
        }
    }

    /**
     * @param {string} path
     * @param {string} text
     */
    _ingest(path, text) {
        this._touch(path);
        this._byFile.set(path, collectStyleDefinitions(text));
        this._rebuildNames();
    }

    _rebuildNames() {
        const next = new Set();
        for (const styles of this._byFile.values()) {
            for (const name of styles.keys()) next.add(name);
        }

        const changed = next.size !== this._names.size || [...next].some((n) => !this._names.has(n));
        this._names = next;
        if (changed) this._onDidChange.fire();
    }

    dispose() {
        this._watcher?.dispose();
        this._saveListener?.dispose();
        this._onDidChange.dispose();
    }
}

module.exports = { StyleIndex };
