'use strict';

const vscode = require('vscode');
const { execFile } = require('node:child_process');
const path = require('node:path');

const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Which scripts to run, and how to tell a figure from a document. The defaults match
 * the layout this was written against; they are settings so the extension is not
 * silently shaped by one project's conventions.
 */
function config() {
  const c = vscode.workspace.getConfiguration('tikz');
  let figureFolders;
  try {
    figureFolders = new RegExp(`(?:^|/)(?:${c.get('figureFolders')})$`);
  } catch {
    vscode.window.showWarningMessage('TikZ: tikz.figureFolders is not a valid regular expression.');
    figureFolders = /(?!)/;
  }
  return {
    figureScript: c.get('figureScript'),
    buildScript: c.get('buildScript'),
    scriptFolders: c.get('scriptFolders'),
    figurePdf: c.get('figurePdf'),
    documentPdf: c.get('documentPdf'),
    viewer: c.get('viewer'),
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
    vscode.window.showErrorMessage('TikZ: no folder open, nothing to build.');
    return;
  }

  const plan = await choose(folder.uri);
  if (!plan) {
    await askForScript(context);
    return;
  }

  const started = Date.now();
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `${plan.label}…` },
    () => run(plan),
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const status = await readStatus(plan.cwd);
  if (status && !status.ok) {
    vscode.window.showErrorMessage(`Build failed — ${status.message}`);
  } else if (result.code !== 0) {
    vscode.window.showErrorMessage(`${plan.label} failed (exit ${result.code})`);
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
      'The build command runs one of your own; copy an example to start.',
    'Show example',
  );
  if (!choice) return;
  const uri = vscode.Uri.joinPath(context.extensionUri, 'examples', 'fig.sh');
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
}

/**
 * Decide which script to run, and from where.
 * @param {vscode.Uri} folder
 * @returns {Promise<{script: string, args: string[], cwd: string, label: string} | null>}
 */
async function choose(folder) {
  const { figureScript, buildScript, scriptFolders, figureFolders } = config();

  const figure = activeFigure(figureFolders);

  for (const dir of scriptFolders) {
    const cwd = path.join(folder.fsPath, dir);
    if (figure && (await exists(path.join(cwd, figureScript)))) {
      return {
        script: figureScript,
        args: [figure.uri.fsPath],
        cwd,
        label: `preview ${path.basename(figure.uri.fsPath, '.tex')}`,
      };
    }
    if (await exists(path.join(cwd, buildScript))) {
      return { script: buildScript, args: [], cwd, label: 'build' };
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

/** @param {{script: string, args: string[], cwd: string}} plan */
function run(plan) {
  return new Promise((resolve) => {
    execFile(
      plan.script,
      plan.args,
      { cwd: plan.cwd, timeout: TIMEOUT_MS },
      (error) => resolve({ code: error ? (error.code ?? 1) : 0 }),
    );
  });
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

/**
 * The scripts leave a one-line summary behind, since their output is not shown anywhere.
 * @param {string} cwd
 * @returns {Promise<{ok: boolean, message: string} | null>}
 */
async function readStatus(cwd) {
  try {
    const uri = vscode.Uri.file(path.join(cwd, 'build', '.build-status'));
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').trim();
    const [verdict, ...rest] = text.split(/\s+/);
    if (verdict !== 'ok' && verdict !== 'fail') return null;
    return { ok: verdict === 'ok', message: rest.join(' ') };
  } catch {
    return null;
  }
}

/**
 * Show the PDF for the file being edited in an external viewer.
 *
 * The build script may hand its output over itself, but only has reason to when the
 * output changed. Rebuilding the same figure, or looking at a chapter while the figure
 * tab sits behind it, leaves the viewer showing something else. This forces it: `open -a`
 * both opens the file and raises the window, and a viewer already holding that file
 * raises the tab rather than duplicating it.
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
    vscode.window.showErrorMessage('TikZ: no folder open, nothing to view.');
    return;
  }

  const { figurePdf, documentPdf, scriptFolders, figureFolders, viewer } = config();
  const relative = activeFigure(figureFolders) ? figurePdf : documentPdf;

  let pdf = null;
  for (const dir of scriptFolders) {
    const candidate = path.join(folder.uri.fsPath, dir, relative);
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
    vscode.window.showErrorMessage('TikZ: no viewer found — set tikz.viewer.');
    return;
  }

  const darwin = process.platform === 'darwin';
  execFile(darwin ? 'open' : app, darwin ? ['-a', app, pdf] : [pdf], (error) => {
    if (error) {
      vscode.window.showErrorMessage(
        `TikZ: could not view ${path.basename(pdf)} — ${error.message}`,
      );
    }
  });
}

/**
 * The bundle carries its version in its name, and so is renamed on every upgrade;
 * hardcoding a path would break at the next one. Newest by name wins.
 */
async function findTeXstudio() {
  if (process.platform !== 'darwin') return null;
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file('/Applications'));
    const apps = entries
      .map(([name]) => name)
      .filter((name) => /^texstudio.*\.app$/i.test(name))
      .sort();
    return apps.length ? path.join('/Applications', apps[apps.length - 1]) : null;
  } catch {
    return null;
  }
}

module.exports = { runBuildAndReport, viewAndReport };
