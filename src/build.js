"use strict";

const vscode = require("vscode");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Which scripts to run, and how to tell a figure from a document. The defaults match
 * the layout this was written against; they are settings so the extension is not
 * silently shaped by one project's conventions.
 */
function config() {
    const c = vscode.workspace.getConfiguration("tikz");
    let figureFolders;
    try {
        figureFolders = new RegExp(`(?:^|/)(?:${c.get("figureFolders")})$`);
    } catch {
        vscode.window.showWarningMessage("TikZ: tikz.figureFolders is not a valid regular expression.");
        figureFolders = /(?!)/;
    }
    return {
        figureScript: c.get("figureScript"),
        buildScript: c.get("buildScript"),
        scriptFolders: c.get("scriptFolders"),
        figurePdf: c.get("figurePdf"),
        documentPdf: c.get("documentPdf"),
        viewer: c.get("viewer"),
        figureFolders,
    };
}

/**
 * Build, and report the outcome as a notification.
 *
 * The script is run directly rather than through a VS Code task. A task spawns a
 * terminal, clears it and reports back through the task-process event, which costs
 * roughly as long again as the build itself -- about two seconds on top of two. Running
 * it here removes all of that. The cost is losing the terminal transcript, which the
 * toast and the log file named in a failure already cover.
 *
 * A project with no script has not finished setting up rather than gone wrong, so that
 * case asks for one instead of reporting a failure.
 */
async function runBuildAndReport(context) {
    try {
        await build(context);
    } catch (err) {
        // Bound to a key with no terminal behind it, so an unhandled throw would
        // otherwise surface as a bare stack trace with no clue which step failed.
        vscode.window.showErrorMessage(`TikZ build error: ${err?.message ?? err}`);
    }
}

async function build(context) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage("TikZ: no folder open, nothing to build.");
        return;
    }

    const plan = await choose(folder.uri);
    if (!plan) {
        await askForScript(context);
        return;
    }

    // The status file is the script's report on this run. One left by an earlier run would
    // otherwise answer for a script that stops before writing its own, or never writes one,
    // when the exit code is meant to decide.
    await clearStatus(plan.cwd);

    const started = Date.now();
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `${plan.label}…` },
        () => run(plan)
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const status = await readStatus(plan.cwd);
    const failed = failure(plan, result);
    if (status && !status.ok) {
        vscode.window.showErrorMessage(`Build failed — ${status.message}`);
    } else if (failed) {
        vscode.window.showErrorMessage(failed);
    } else {
        const what = status?.message ?? plan.label;
        vscode.window.showInformationMessage(`Built ${what} in ${seconds}s`);
    }
}

/**
 * The extension runs your build rather than owning one, since only the project knows
 * which preamble a figure has to compile against. With no script there is nothing to
 * run, which is a step not yet taken rather than an error, so it is said that way and
 * the example is one click off.
 * @param {vscode.ExtensionContext} context
 */
async function askForScript(context) {
    const { figureScript, buildScript } = config();
    const choice = await vscode.window.showInformationMessage(
        `TikZ needs a build script: no ${figureScript} or ${buildScript} in this workspace. ` +
            "The build command runs one of your own; copy an example to start.",
        "Show example"
    );
    if (!choice) return;
    const uri = vscode.Uri.joinPath(context.extensionUri, "examples", "fig.sh");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/**
 * Decide which script to run, and from where.
 * @param {vscode.Uri} folder
 *
 * Each script is resolved against its folder once, and that path is both checked and run.
 * Joining it on instead turned an absolute setting into a path inside the folder, so it
 * was never found; and running the bare setting let `build.sh`, written without ./, be
 * looked up on the PATH after it had been found in the folder.
 * @returns {Promise<{script: string, file: string, args: string[], cwd: string, label: string} | null>}
 */
async function choose(folder) {
    const { figureScript, buildScript, scriptFolders, figureFolders } = config();

    const figure = activeFigure(figureFolders);

    for (const dir of scriptFolders) {
        const cwd = path.join(folder.fsPath, dir);
        const figureFile = path.resolve(cwd, figureScript);
        if (figure && (await exists(figureFile))) {
            return {
                script: figureScript,
                file: figureFile,
                args: [figure.uri.fsPath],
                cwd,
                label: `preview ${path.basename(figure.uri.fsPath, ".tex")}`,
            };
        }
        const buildFile = path.resolve(cwd, buildScript);
        if (await exists(buildFile)) {
            return { script: buildScript, file: buildFile, args: [], cwd, label: "build" };
        }
    }
    return null;
}

/**
 * The active document, when it is a figure rather than part of the document.
 * @param {RegExp} figureFolders
 * @returns {vscode.TextDocument | null}
 */
function activeFigure(figureFolders) {
    const active = vscode.window.activeTextEditor?.document;
    const isFigure =
        active?.languageId &&
        /^(latex|tex|tikz)$/.test(active.languageId) &&
        figureFolders.test(path.dirname(active.uri.fsPath));
    return isFigure ? active : null;
}

/**
 * Run the script to the end, discarding what it prints.
 *
 * spawn rather than execFile, which buffers the output and kills the script once that
 * passes a megabyte -- so a script leaving latexmk's output on the terminal was stopped
 * halfway through a build. Nothing here shows the output, so none is collected.
 * @param {{file: string, args: string[], cwd: string}} plan
 * @returns {Promise<{code: number | null, signal: string | null, error: Error | null, timedOut: boolean}>}
 */
function run(plan) {
    return new Promise((resolve) => {
        const child = spawn(plan.file, plan.args, { cwd: plan.cwd, stdio: "ignore" });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, TIMEOUT_MS);
        // A script that cannot start raises "error" and may never raise "exit"; the
        // first of the two settles the promise.
        child.on("error", (error) => {
            clearTimeout(timer);
            resolve({ code: null, signal: null, error, timedOut });
        });
        child.on("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, error: null, timedOut });
        });
    });
}

/**
 * What went wrong running the script, said in terms of what to do about it, or null when
 * it exited 0. A spawn failure has no exit code at all, and quoting its error code as one
 * ("exit EACCES") told nobody that the script had merely lost its executable bit.
 * @param {{script: string, label: string}} plan
 * @param {Awaited<ReturnType<typeof run>>} result
 */
function failure(plan, { code, signal, error, timedOut }) {
    if (error?.code === "EACCES") return `TikZ: ${plan.script} is not executable — chmod +x it, then build again.`;
    if (error) return `TikZ: could not run ${plan.script} — ${error.message}`;
    if (timedOut) return `${plan.label} timed out after ${TIMEOUT_MS / 60000} minutes`;
    if (signal) return `${plan.label} was stopped by ${signal}`;
    if (code !== 0) return `${plan.label} failed (exit ${code})`;
    return null;
}

/** @param {string} file */
async function exists(file) {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(file));
        return true;
    } catch {
        return false;
    }
}

/** @param {string} cwd */
function statusUri(cwd) {
    return vscode.Uri.file(path.join(cwd, "build", ".build-status"));
}

/** @param {string} cwd */
async function clearStatus(cwd) {
    try {
        await vscode.workspace.fs.delete(statusUri(cwd));
    } catch {
        // None there yet.
    }
}

/**
 * The scripts leave a one-line summary behind, since their output is not shown anywhere.
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, message: string} | null>}
 */
async function readStatus(cwd) {
    try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(statusUri(cwd)))
            .toString("utf8")
            .trim();
        const [verdict, ...rest] = text.split(/\s+/);
        if (verdict !== "ok" && verdict !== "fail") return null;
        return { ok: verdict === "ok", message: rest.join(" ") };
    } catch {
        return null;
    }
}

/**
 * Show the PDF for the file being edited in an external viewer.
 *
 * The build script may hand its output over itself, but only has reason to when the
 * output changed. Rebuilding the same figure, or looking at a chapter while the figure
 * tab sits behind it, leaves the viewer showing something else. This forces it: the
 * viewer is asked to open the file, and one already holding it raises that tab rather
 * than duplicating it.
 */
async function viewAndReport() {
    try {
        await view();
    } catch (err) {
        vscode.window.showErrorMessage(`TikZ view error: ${err?.message ?? err}`);
    }
}

async function view() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showErrorMessage("TikZ: no folder open, nothing to view.");
        return;
    }

    const { figurePdf, documentPdf, scriptFolders, figureFolders, viewer } = config();
    const relative = activeFigure(figureFolders) ? figurePdf : documentPdf;

    let pdf = null;
    for (const dir of scriptFolders) {
        const candidate = path.resolve(folder.uri.fsPath, dir, relative);
        if (await exists(candidate)) {
            pdf = candidate;
            break;
        }
    }
    if (!pdf) {
        vscode.window.showWarningMessage(`TikZ: no ${relative} to view — build it first.`);
        return;
    }

    const app = viewer || (await findTeXstudio());
    if (!app) {
        vscode.window.showErrorMessage("TikZ: no viewer found — set tikz.viewer.");
        return;
    }
    const binary = await executable(app);
    if (!binary) {
        vscode.window.showErrorMessage(`TikZ: ${path.basename(app)} holds no executable to run.`);
        return;
    }

    // The binary is run directly rather than through `open -a`. TeXstudio's bundle lists
    // only tex, bib, sty, cls and mp in CFBundleDocumentTypes, so `open` accepts a PDF,
    // exits 0, raises the window -- and drops the file, leaving whatever tab was already
    // showing. Handing the path to the executable is what the running instance acts on.
    //
    // Detached, since a viewer started this way is the application itself and must outlive
    // the window that asked for it. A second invocation forwards the file and exits, so
    // only the failure to spawn is worth reporting; an exit code arrives too late to mean
    // anything.
    const child = spawn(binary, [pdf], { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
        vscode.window.showErrorMessage(`TikZ: could not view ${path.basename(pdf)} — ${error.message}`);
    });
    child.unref();
}

/**
 * The program to run for a viewer. A macOS application is a directory, so the setting
 * may name either the bundle or the executable inside it; the bundle holds exactly one.
 * @param {string} app
 * @returns {Promise<string | null>}
 */
async function executable(app) {
    if (!app.endsWith(".app")) return app;
    try {
        const dir = path.join(app, "Contents", "MacOS");
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        const [name] = entries.find(([, type]) => type === vscode.FileType.File) ?? [];
        return name ? path.join(dir, name) : null;
    } catch {
        return null;
    }
}

/**
 * The TeXstudio to hand the PDF to when tikz.viewer is empty.
 *
 * On macOS the bundle carries its version in its name, and so is renamed on every
 * upgrade; hardcoding a path would break at the next one. The newest by version wins,
 * compared number by number -- by plain string order texstudio-4.8.9 sorts after
 * texstudio-4.8.10. On Linux the packages put a texstudio on the PATH.
 */
async function findTeXstudio() {
    if (process.platform === "linux") return onPath("texstudio");
    if (process.platform !== "darwin") return null;
    try {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file("/Applications"));
        const apps = entries
            .map(([name]) => name)
            .filter((name) => /^texstudio.*\.app$/i.test(name))
            .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
        return apps.length ? path.join("/Applications", apps[apps.length - 1]) : null;
    } catch {
        return null;
    }
}

/**
 * The first executable called `name` on the PATH, as a shell would find it.
 * @param {string} name
 */
async function onPath(name) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, name);
        try {
            await fs.promises.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // Not here.
        }
    }
    return null;
}

module.exports = { runBuildAndReport, viewAndReport };
