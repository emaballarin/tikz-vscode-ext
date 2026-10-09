// Which VS Code is running this script, found from the runtime itself.
//
// tools/tm runs scripts under VS Code's own Electron, so process.execPath is the editor
// executable, and the application folder sits at a fixed place beside it. Deriving it
// from there, rather than from a list of install paths, means a script always reads the
// libraries, grammars and themes of the very VS Code that tools/tm picked.

import fs from "node:fs";
import path from "node:path";

/**
 * The installation's resources/app folder and its product.json, or null when this is not
 * running under VS Code's Electron.
 * @returns {{app: string, product: Record<string, any>, version: string} | null}
 */
export function findVSCode() {
    const exe = process.execPath;
    const candidates = [
        path.resolve(path.dirname(exe), "resources", "app"), // Linux: <install>/<executable>
        path.resolve(path.dirname(exe), "..", "Resources", "app"), // macOS: <bundle>/Contents/MacOS/<executable>
    ];
    for (const app of candidates) {
        const productFile = path.join(app, "product.json");
        if (!fs.existsSync(productFile)) continue;
        const product = JSON.parse(fs.readFileSync(productFile, "utf8"));
        const { version } = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
        return { app, product, version };
    }
    return null;
}

/** One line naming the build, for reports that depend on which VS Code produced them. */
export function describe(found) {
    const { product, version } = found;
    return `${product.nameLong ?? "VS Code"} ${version} (${product.quality ?? "unknown"}, ${String(product.commit ?? "").slice(0, 7)})`;
}
