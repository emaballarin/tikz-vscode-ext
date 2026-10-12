"use strict";

// Runs the extension against a stub of the `vscode` API.
//
// There is no extension host here, so nothing can press F6 or watch a theme paint a token.
// What can be checked is everything behind those: what activation registers, which tokens
// the provider reports and when it asks to be asked again, what the style index holds,
// and what the build and view commands run and say. Those are the parts that fail without
// an error -- a stale token list, a stale verdict, a script that is never found.
//
// The build tests run real shell scripts in a temporary folder, so they exercise the
// actual process handling, on macOS and Linux alike.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const manifest = require("../package.json");

// --- the stub ---------------------------------------------------------------------------

class EventEmitter {
    constructor() {
        this.listeners = [];
        this.event = (listener) => {
            this.listeners.push(listener);
            return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
        };
    }
    fire(value) {
        for (const listener of this.listeners) listener(value);
    }
    dispose() {
        this.listeners = [];
    }
}

class Range {
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}

class SemanticTokensLegend {
    constructor(tokenTypes, tokenModifiers) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}

/** Records what was pushed rather than encoding it, so tests read offsets directly. */
class SemanticTokensBuilder {
    constructor() {
        this.pushed = [];
    }
    push(range, type, modifiers) {
        this.pushed.push({ start: range.start, end: range.end, type, modifiers });
    }
    build() {
        return { pushed: this.pushed };
    }
}

const uri = (fsPath) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` });

/** /Applications, or the folder a test stands in for it. */
const applications = (p) => (state.applications ? p.replace(/^\/Applications(?=\/|$)/, state.applications) : p);

/** Mutable state the stub reads; reset() puts it back before every test. */
const state = {};
function reset() {
    state.settings = Object.fromEntries(
        Object.entries(manifest.contributes.configuration.properties).map(([key, p]) => [
            key.replace(/^tikz\./, ""),
            p.default,
        ])
    );
    state.folders = [];
    state.active = null;
    state.messages = [];
    state.answer = undefined;
    state.found = [];
    state.watchers = [];
    state.saveListeners = [];
    state.providers = [];
    state.commands = new Map();
    state.opened = [];
    state.applications = null;
    state.slowRead = null;
    state.slowFind = null;
}

const vscode = {
    EventEmitter,
    Range,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    FileType: { File: 1, Directory: 2 },
    ProgressLocation: { Window: 10 },
    Uri: {
        file: uri,
        joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    },
    workspace: {
        get workspaceFolders() {
            return state.folders.length ? state.folders.map((p) => ({ uri: uri(p) })) : undefined;
        },
        getConfiguration: () => ({ get: (key) => state.settings[key] }),
        fs: {
            stat: async (u) => fs.promises.stat(u.fsPath),
            readFile: async (u) => {
                if (state.slowRead) await state.slowRead;
                return new Uint8Array(await fs.promises.readFile(u.fsPath));
            },
            readDirectory: async (u) =>
                (await fs.promises.readdir(applications(u.fsPath), { withFileTypes: true })).map((d) => [
                    d.name,
                    d.isDirectory() ? 2 : 1,
                ]),
            delete: async (u) => fs.promises.rm(u.fsPath),
        },
        findFiles: async () => {
            if (state.slowFind) await state.slowFind;
            return state.found.map(uri);
        },
        createFileSystemWatcher: () => {
            const watcher = {
                create: new EventEmitter(),
                change: new EventEmitter(),
                del: new EventEmitter(),
                disposed: false,
            };
            watcher.onDidCreate = watcher.create.event;
            watcher.onDidChange = watcher.change.event;
            watcher.onDidDelete = watcher.del.event;
            watcher.dispose = () => (watcher.disposed = true);
            state.watchers.push(watcher);
            return watcher;
        },
        onDidSaveTextDocument: (listener) => {
            state.saveListeners.push(listener);
            return { dispose: () => (state.saveListeners = state.saveListeners.filter((l) => l !== listener)) };
        },
        openTextDocument: async (u) => ({ uri: u }),
    },
    window: {
        get activeTextEditor() {
            return state.active ? { document: state.active } : undefined;
        },
        showInformationMessage: async (text) => {
            state.messages.push(["info", text]);
            return state.answer;
        },
        showWarningMessage: async (text) => {
            state.messages.push(["warning", text]);
        },
        showErrorMessage: async (text) => {
            state.messages.push(["error", text]);
        },
        withProgress: async (_options, task) => task(),
        showTextDocument: async (document) => state.opened.push(document.uri.fsPath),
    },
    languages: {
        registerDocumentSemanticTokensProvider: (selector, provider, legend) => {
            state.providers.push({ selector, provider, legend });
            return { dispose() {} };
        },
    },
    commands: {
        registerCommand: (id, handler) => {
            state.commands.set(id, handler);
            return { dispose() {} };
        },
    },
};

const load = Module._load;
Module._load = function (request, ...rest) {
    return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

// --- helpers ----------------------------------------------------------------------------

/** A TextDocument over `text`, with offsets standing in for positions. */
function documentOf(text, { version = 1, file = "/w/fig.tex", languageId = "latex" } = {}) {
    return {
        uri: uri(file),
        version,
        languageId,
        getText: () => text,
        positionAt: (offset) => offset,
    };
}

/** A temporary folder with `files` written into it; executable when the value says so. */
const made = [];
function folder(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tikz-test-"));
    made.push(root);
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const [text, mode] = Array.isArray(content) ? content : [content, 0o644];
        fs.writeFileSync(target, text, { mode });
    }
    return root;
}

const script = (body) => [`#!/bin/sh\n${body}\n`, 0o755];

const tests = [];
const test = (name, body) => tests.push({ name, body });

// --- activation -------------------------------------------------------------------------

const { activate } = require("../src/extension");
const { TikzSemanticTokensProvider } = require("../src/semantic");
const { StyleIndex } = require("../src/styleIndex");
const build = require("../src/build");

test("activation registers a provider per language and every contributed command", async () => {
    const context = { subscriptions: [], extensionUri: uri(path.resolve(__dirname, "..")) };
    await activate(context);
    const languages = state.providers.map((p) => p.selector.language).sort();
    assert.deepStrictEqual(languages, ["latex", "tex", "tikz"]);
    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    assert.deepStrictEqual([...state.commands.keys()].sort(), declared);
    const legend = state.providers[0].legend.tokenTypes;
    assert.deepStrictEqual(
        legend,
        manifest.contributes.semanticTokenTypes.map((t) => t.id)
    );
});

// --- semantic tokens --------------------------------------------------------------------

/** A stand-in for the workspace index: a set of names and a change event. */
function fakeIndex(names = []) {
    const emitter = new EventEmitter();
    return { names: new Set(names), onDidChange: emitter.event, emitter };
}

test("a macro defined in the file is marked at its definition and its uses", async () => {
    const text = "\\def\\eps{1}\n\\begin{tikzpicture}\\draw (0,\\eps) -- (1,1);\\end{tikzpicture}";
    const { pushed } = new TikzSemanticTokensProvider(fakeIndex()).provideDocumentSemanticTokens(documentOf(text));
    const marks = pushed.map((t) => [text.slice(t.start, t.end), t.type, t.modifiers.join()]);
    assert.deepStrictEqual(marks, [
        ["\\eps", "tikzMacro", "declaration"],
        ["\\eps", "tikzMacro", ""],
    ]);
});

test("a known style is marked only where it is applied, not where a key shares its name", async () => {
    const text = [
        "\\begin{tikzpicture}",
        "  \\draw [thick, neuron] (0,0) -- (1,1);",
        "  \\addplot table [x=xc] {data.csv};",
        "  \\node {$\\vx[neuron]$};",
        "\\end{tikzpicture}",
    ].join("\n");
    const provider = new TikzSemanticTokensProvider(fakeIndex(["neuron", "x"]));
    const { pushed } = provider.provideDocumentSemanticTokens(documentOf(text));
    assert.deepStrictEqual(
        pushed.map((t) => [text.slice(t.start, t.end), t.type]),
        [["neuron", "tikzStyle"]]
    );
});

test("a style the index learns reaches a document whose text has not changed", async () => {
    // The order of a window opening with a figure in it: the figure asks for tokens before
    // the workspace scan has finished, then the scan lands and asks for a refresh.
    const index = fakeIndex();
    const provider = new TikzSemanticTokensProvider(index);
    let refreshes = 0;
    provider.onDidChangeSemanticTokens(() => refreshes++);
    const document = documentOf("\\begin{tikzpicture}\\draw [neuron] (0,0);\\end{tikzpicture}");
    assert.strictEqual(provider.provideDocumentSemanticTokens(document).pushed.length, 0);

    index.names = new Set(["neuron"]);
    index.emitter.fire();
    assert.strictEqual(refreshes, 1, "the provider should ask to be asked again");
    const { pushed } = provider.provideDocumentSemanticTokens(document);
    assert.deepStrictEqual(
        pushed.map((t) => t.type),
        ["tikzStyle"],
        "and then answer with the new style"
    );
});

// --- style index ------------------------------------------------------------------------

test("the style index collects definitions from every file it is given", async () => {
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}", "b.sty": "\\tikzset{flow/.style={->}}" });
    state.found = [path.join(root, "pre.tex"), path.join(root, "b.sty")];
    const index = new StyleIndex();
    await index.refreshAll();
    assert.deepStrictEqual([...index.names].sort(), ["flow", "neuron"]);
});

test("a file the watcher reports deleted leaves the index", async () => {
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}" });
    state.found = [path.join(root, "pre.tex")];
    const index = new StyleIndex();
    await index.start();
    let changes = 0;
    index.onDidChange(() => changes++);
    state.watchers[0].del.fire(uri(path.join(root, "pre.tex")));
    assert.deepStrictEqual([...index.names], []);
    assert.strictEqual(changes, 1);
    index.dispose();
});

test("rebuilding the index forgets a file that is gone, even with no watcher event for it", async () => {
    // VS Code documents that deleting a folder may report the folder alone, not the files
    // in it -- so the watcher never says, and Rebuild is the only way back.
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}", "old/a.tex": "\\tikzset{gone/.style={red}}" });
    state.found = [path.join(root, "pre.tex"), path.join(root, "old", "a.tex")];
    const index = new StyleIndex();
    await index.refreshAll();
    fs.rmSync(path.join(root, "old"), { recursive: true });
    state.found = [path.join(root, "pre.tex")];
    await index.refreshAll();
    assert.deepStrictEqual([...index.names], ["neuron"]);
});

test("disposing the index lets go of everything it subscribed to", async () => {
    const index = new StyleIndex();
    await index.start();
    assert.strictEqual(state.saveListeners.length, 1);
    index.dispose();
    assert.strictEqual(state.saveListeners.length, 0, "the save listener outlived the index");
    assert.ok(
        state.watchers.every((w) => w.disposed),
        "a watcher outlived the index"
    );
});

test("a save landing while the index rebuilds is kept", async () => {
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}" });
    state.found = [path.join(root, "pre.tex")];
    const index = new StyleIndex();
    let release;
    state.slowRead = new Promise((resolve) => (release = resolve));
    const rebuilding = index.refreshAll();
    await new Promise((r) => setImmediate(r));
    // A new file saved mid-rebuild: the watcher's scan never listed it.
    index._ingest(path.join(root, "new.tex"), "\\tikzset{fresh/.style={red}}");
    release();
    await rebuilding;
    assert.deepStrictEqual([...index.names].sort(), ["fresh", "neuron"]);
});

test("a file saved while the rebuild is still scanning is kept", async () => {
    // The scan's list is fixed when it returns, so a file created and saved before then is
    // not on it -- and must not be pruned as if it had vanished.
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}" });
    state.found = [path.join(root, "pre.tex")];
    const index = new StyleIndex();
    let release;
    state.slowFind = new Promise((resolve) => (release = resolve));
    const rebuilding = index.refreshAll();
    await new Promise((r) => setImmediate(r));
    index._ingest(path.join(root, "new.tex"), "\\tikzset{fresh/.style={red}}");
    release();
    await rebuilding;
    assert.deepStrictEqual([...index.names].sort(), ["fresh", "neuron"]);
});

test("two rebuilds overlapping keep what was saved during either, and neither throws", async () => {
    const root = folder({ "pre.tex": "\\tikzset{neuron/.style={draw}}" });
    state.found = [path.join(root, "pre.tex")];
    const index = new StyleIndex();
    let releaseFirst;
    state.slowFind = new Promise((resolve) => (releaseFirst = resolve));
    const first = index.refreshAll();
    await new Promise((r) => setImmediate(r));
    let releaseSecond;
    state.slowFind = new Promise((resolve) => (releaseSecond = resolve));
    const second = index.refreshAll();
    await new Promise((r) => setImmediate(r));
    index._ingest(path.join(root, "saved.tex"), "\\tikzset{saved/.style={red}}");
    // The watcher's report of a new file, the other way a file reaches the index.
    fs.writeFileSync(path.join(root, "watched.tex"), "\\tikzset{watched/.style={blue}}");
    const watched = index.refreshFile(uri(path.join(root, "watched.tex")));
    releaseFirst();
    await first;
    releaseSecond();
    await second;
    await watched;
    assert.deepStrictEqual([...index.names].sort(), ["neuron", "saved", "watched"]);
});

// --- build ------------------------------------------------------------------------------

/** Run the build command against `root` with `active` open, and return what it said. */
async function runBuild(root, active = null) {
    state.folders = [root];
    state.active = active;
    await build.runBuildAndReport({ extensionUri: uri(path.resolve(__dirname, "..")) });
    return state.messages;
}

const figureIn = (root, name = "ch1-figs/flow.tex") =>
    documentOf("", { file: path.join(root, "latex", name), languageId: name.endsWith(".tikz") ? "tikz" : "latex" });

test("a figure runs the figure script with its path, from the folder holding the script", async () => {
    const root = folder({
        "latex/fig.sh": script('pwd > ran; echo "$1" >> ran; mkdir -p build; echo "ok flow" > build/.build-status'),
        "latex/ch1-figs/flow.tex": "",
    });
    const messages = await runBuild(root, figureIn(root));
    const [cwd, arg] = fs
        .readFileSync(path.join(root, "latex", "ran"), "utf8")
        .trim()
        .split("\n");
    assert.strictEqual(fs.realpathSync(cwd), fs.realpathSync(path.join(root, "latex")));
    assert.strictEqual(arg, path.join(root, "latex", "ch1-figs", "flow.tex"));
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0][1], /^Built flow in \d+\.\ds$/);
});

test("a .tikz figure is named without its extension", async () => {
    const root = folder({ "latex/fig.sh": script("exit 0"), "latex/ch1-figs/flow.tikz": "" });
    const messages = await runBuild(root, figureIn(root, "ch1-figs/flow.tikz"));
    assert.match(messages[0][1], /^Built preview flow in /);
});

test("anything else runs the build script, with no arguments", async () => {
    const root = folder({ "build.sh": script('echo "$#" > ran') });
    const messages = await runBuild(root, documentOf("", { file: path.join(root, "main.tex") }));
    assert.strictEqual(fs.readFileSync(path.join(root, "ran"), "utf8").trim(), "0");
    assert.match(messages[0][1], /^Built build in /);
});

test("a script given by absolute path is found there", async () => {
    const elsewhere = folder({ "build.sh": script('echo ran > "$(dirname "$0")/ran"') });
    state.settings.buildScript = path.join(elsewhere, "build.sh");
    const messages = await runBuild(folder({}));
    assert.ok(fs.existsSync(path.join(elsewhere, "ran")), JSON.stringify(messages));
});

test("a script named without ./ is the one in the script folder, not one on the PATH", async () => {
    const root = folder({ "build.sh": script("echo ran > ran") });
    state.settings.buildScript = "build.sh";
    const messages = await runBuild(root);
    assert.ok(fs.existsSync(path.join(root, "ran")), JSON.stringify(messages));
});

test("an absolute script folder is searched where it says", async () => {
    const scripts = folder({ "build.sh": script('echo ran > "$(dirname "$0")/ran"') });
    state.settings.scriptFolders = [scripts];
    const messages = await runBuild(folder({}));
    assert.ok(fs.existsSync(path.join(scripts, "ran")), JSON.stringify(messages));
});

test("a fail line in the status file is reported, whatever the exit code", async () => {
    const root = folder({ "build.sh": script('mkdir -p build; echo "fail see build/main.log" > build/.build-status') });
    const messages = await runBuild(root);
    assert.deepStrictEqual(messages, [["error", "Build failed — see build/main.log"]]);
});

test("without a status file the exit code decides", async () => {
    const root = folder({ "build.sh": script("exit 3") });
    const messages = await runBuild(root);
    assert.deepStrictEqual(messages, [["error", "build failed (exit 3)"]]);
});

test("a verdict left by an earlier run does not answer for this one", async () => {
    // The README promises the exit code decides when the script writes no status; a file
    // from the last run was read as this run's instead, turning a success into a failure.
    const root = folder({ "build.sh": script("exit 0"), "build/.build-status": "fail see build/main.log\n" });
    const messages = await runBuild(root);
    assert.strictEqual(messages.length, 1, JSON.stringify(messages));
    assert.deepStrictEqual(messages[0][0], "info", JSON.stringify(messages));
    assert.match(messages[0][1], /^Built build in /);
});

test("a script that prints more than a pipe holds still runs to the end", async () => {
    // execFile buffered the output and killed the script past a megabyte; latexmk on a
    // whole document, left on the terminal by a script that does not redirect it, is that.
    const root = folder({
        "build.sh": script(
            'head -c 2000000 /dev/zero | tr "\\0" x; mkdir -p build; echo "ok main.tex" > build/.build-status'
        ),
    });
    const messages = await runBuild(root);
    assert.strictEqual(messages.length, 1, JSON.stringify(messages));
    assert.match(messages[0][1], /^Built main\.tex in /);
});

test("a script that cannot be executed is named, with the fix", async () => {
    const root = folder({ "build.sh": "#!/bin/sh\nexit 0\n" });
    const messages = await runBuild(root);
    assert.deepStrictEqual(messages, [
        ["error", "TikZ: ./build.sh is not executable — chmod +x it, then build again."],
    ]);
});

test("a script stopped by a signal says so rather than quoting an exit code", async () => {
    const root = folder({ "build.sh": script("kill -TERM $$") });
    const messages = await runBuild(root);
    assert.deepStrictEqual(messages, [["error", "build was stopped by SIGTERM"]]);
});

test("with no script anywhere, the build asks for one and can show the example", async () => {
    const root = folder({});
    state.answer = "Show example";
    const messages = await runBuild(root);
    assert.strictEqual(messages[0][0], "info");
    assert.match(messages[0][1], /needs a build script/);
    assert.strictEqual(path.basename(state.opened[0]), "fig.sh");
});

// --- view -------------------------------------------------------------------------------

test("view hands the PDF for the active file to the configured viewer", async () => {
    const root = folder({ "build/main.pdf": "%PDF", "viewer.sh": script('echo "$1" > "$(dirname "$0")/viewed"') });
    state.folders = [root];
    state.settings.viewer = path.join(root, "viewer.sh");
    await build.viewAndReport();
    const viewed = path.join(root, "viewed");
    for (let i = 0; i < 50 && !fs.existsSync(viewed); i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(fs.readFileSync(viewed, "utf8").trim(), path.join(root, "build", "main.pdf"));
    assert.deepStrictEqual(state.messages, []);
});

/** Run `body` as if on `platform`, with `env` over the environment, restoring both after. */
async function on(platform, env, body) {
    const real = process.platform;
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.defineProperty(process, "platform", { value: platform });
    Object.assign(process.env, env);
    try {
        await body();
    } finally {
        Object.defineProperty(process, "platform", { value: real });
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** Wait for `predicate`, which the detached viewer satisfies a moment after it starts. */
async function eventually(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20));
}

test("on macOS, with no viewer set, the newest TeXstudio by version is the one asked", async () => {
    // By string order texstudio-4.8.9 sorts after texstudio-4.8.10.
    const apps = folder({
        "texstudio-4.8.9.app/Contents/MacOS/texstudio": "",
        "texstudio-4.8.10.app/Contents/MacOS/texstudio": "",
        "TextEdit.app/Contents/MacOS/TextEdit": "",
    });
    state.folders = [folder({ "build/main.pdf": "%PDF" })];
    state.applications = apps;
    await on("darwin", {}, async () => {
        await build.viewAndReport();
        // /Applications itself is not touched, so starting the binary fails, naming it.
        await eventually(() => state.messages.length);
    });
    assert.strictEqual(state.messages.length, 1, JSON.stringify(state.messages));
    assert.match(state.messages[0][1], /texstudio-4\.8\.10\.app\/Contents\/MacOS\/texstudio/);
});

test("on Linux, with no viewer set, the texstudio on the PATH is the one asked", async () => {
    const bin = folder({ texstudio: script('echo "$1" > "$(dirname "$0")/viewed"') });
    const root = folder({ "build/main.pdf": "%PDF" });
    state.folders = [root];
    await on("linux", { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, async () => {
        await build.viewAndReport();
        await eventually(() => fs.existsSync(path.join(bin, "viewed")));
    });
    assert.deepStrictEqual(state.messages, []);
    assert.strictEqual(fs.readFileSync(path.join(bin, "viewed"), "utf8").trim(), path.join(root, "build", "main.pdf"));
});

test("view says so when there is no PDF yet", async () => {
    state.folders = [folder({})];
    await build.viewAndReport();
    assert.deepStrictEqual(state.messages, [["warning", "TikZ: no build/main.pdf to view — build it first."]]);
});

// --- run --------------------------------------------------------------------------------

(async () => {
    let failed = 0;
    for (const { name, body } of tests) {
        reset();
        try {
            await body();
        } catch (error) {
            failed++;
            console.error(`FAIL ${name}\n  ${error.message.split("\n").join("\n  ")}`);
        }
    }
    for (const root of made) fs.rmSync(root, { recursive: true, force: true });
    if (failed) process.exitCode = 1;
    else console.log(`ok: ${tests.length} extension tests`);
})();
