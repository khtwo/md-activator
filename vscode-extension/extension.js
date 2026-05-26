const cp = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_PORT_START = 49152;
const MAX_PORT = 65535;
const RUNTIME_CHECK_TIMEOUT_MS = 15000;
const RUNTIME_OUTPUT_LIMIT = 2000;

let currentServer = null;
let outputChannel = null;

function getVscode() {
  return require("vscode");
}

function normalizePathForUrl(filePath) {
  return filePath.replace(/\\/g, "/");
}

function encodeRelativePath(relativePath) {
  return normalizePathForUrl(relativePath)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvePreviewTarget(filePath, workspaceRoots = []) {
  const resolvedFilePath = path.resolve(filePath);
  const matchingRoot = workspaceRoots
    .map((workspaceRoot) => path.resolve(workspaceRoot))
    .filter((workspaceRoot) => isPathInside(workspaceRoot, resolvedFilePath))
    .sort((left, right) => right.length - left.length)[0];
  const contentRoot = matchingRoot || path.dirname(resolvedFilePath);
  const relativePath = normalizePathForUrl(path.relative(contentRoot, resolvedFilePath));

  return { contentRoot, relativePath };
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(startPort = DEFAULT_PORT_START, maxPort = MAX_PORT) {
  for (let port = startPort; port <= maxPort; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free localhost port found from ${startPort} to ${maxPort}`);
}

function buildWebviewHtml({ webviewPort, relativePath }) {
  const encodedPath = encodeRelativePath(relativePath);
  const src = `http://localhost:${webviewPort}/${encodedPath}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; frame-src http://localhost:${webviewPort}; style-src 'unsafe-inline';"
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MD Activator Preview</title>
  <style>
    html, body, iframe {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
  </style>
</head>
<body>
  <iframe title="MD Activator Preview" src="${src}"></iframe>
</body>
</html>`;
}

function buildWebviewOptions({ serverPort }) {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: serverPort, extensionHostPort: serverPort }],
  };
}

function serverRootForExtension(extensionPath) {
  return path.join(extensionPath, "server");
}

function serverEntryExists(serverRoot) {
  return fs.existsSync(path.join(serverRoot, "app", "main.py"));
}

function appendOutput(message) {
  if (outputChannel) {
    outputChannel.appendLine(message);
  }
}

function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

function truncateOutput(value, limit = RUNTIME_OUTPUT_LIMIT) {
  const text = String(value || "").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function buildRuntimeChecks({ uvPath, serverRoot }) {
  return [
    {
      label: "uv",
      command: uvPath,
      args: ["--version"],
      cwd: serverRoot,
    },
    {
      label: "Python runtime",
      command: uvPath,
      args: ["run", "--native-tls", "python", "--version"],
      cwd: serverRoot,
    },
  ];
}

function buildRuntimeCheckFailureMessage(check, result) {
  const command = formatCommand(check.command, check.args);
  const details = [];

  if (result.error) {
    details.push(`Error: ${result.error.message}`);
  }
  if (result.code !== undefined && result.code !== null) {
    details.push(`Exit code: ${result.code}`);
  }
  if (result.stdout) {
    details.push(`stdout: ${truncateOutput(result.stdout)}`);
  }
  if (result.stderr) {
    details.push(`stderr: ${truncateOutput(result.stderr)}`);
  }

  const detailText = details.length ? `\n${details.join("\n")}` : "";

  if (check.label === "uv") {
    return (
      `MD Activator cannot run the configured uv command "${check.command}". ` +
      `Install uv or set mdActivator.uvPath to the uv executable path. Command: ${command}.${detailText}`
    );
  }

  return (
    `MD Activator cannot resolve a Python runtime with "${command}". ` +
    `Install Python 3.11+ or configure uv so it can provide Python for the staged server environment.${detailText}`
  );
}

function runRuntimeCheck(check, timeoutMs = RUNTIME_CHECK_TIMEOUT_MS) {
  appendOutput(`Runtime check: ${formatCommand(check.command, check.args)}`);

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = cp.spawn(check.command, check.args, {
      cwd: check.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };

    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish({ timedOut: true, error: new Error(`Runtime check timed out after ${timeoutMs} ms`) });
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", (error) => {
      finish({ error });
    });
    child.once("close", (code) => {
      finish({ code });
    });
  });
}

async function verifyRuntime({ uvPath, serverRoot }) {
  for (const check of buildRuntimeChecks({ uvPath, serverRoot })) {
    const result = await runRuntimeCheck(check);
    if (result.error || result.code !== 0) {
      const message = buildRuntimeCheckFailureMessage(check, result);
      appendOutput(message);
      throw new Error(message);
    }

    const output = truncateOutput(result.stdout || result.stderr);
    appendOutput(`${check.label} runtime check passed${output ? `: ${output}` : ""}`);
  }
}

function getConfiguration(vscode) {
  const config = vscode.workspace.getConfiguration("mdActivator");
  return {
    portStart: config.get("portStart", DEFAULT_PORT_START),
    uvPath: config.get("uvPath", "uv"),
  };
}

function workspaceRoots(vscode) {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function activeMarkdownFile(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file" || editor.document.languageId !== "markdown") {
    return null;
  }
  return editor.document.uri.fsPath;
}

function isMarkdownFilePath(filePath) {
  return [".md", ".markdown", ".mdown", ".mkdn"].includes(path.extname(filePath).toLowerCase());
}

function markdownFileFromCommandResource(vscode, resourceUri) {
  if (!resourceUri || resourceUri.scheme !== "file" || !resourceUri.fsPath) {
    return null;
  }

  const matchingDocument = (vscode.workspace.textDocuments || []).find(
    (document) => document.uri && document.uri.fsPath === resourceUri.fsPath,
  );
  if (matchingDocument) {
    return matchingDocument.languageId === "markdown" ? resourceUri.fsPath : null;
  }

  return isMarkdownFilePath(resourceUri.fsPath) ? resourceUri.fsPath : null;
}

function markdownFileForPreviewCommand(vscode, resourceUri) {
  if (resourceUri) {
    return markdownFileFromCommandResource(vscode, resourceUri);
  }

  return activeMarkdownFile(vscode);
}

function stopCurrentServer() {
  if (!currentServer) {
    return;
  }

  appendOutput(`Stopping server for ${currentServer.contentRoot}`);
  terminateProcessTree(currentServer.process);
  currentServer = null;
}

function buildWindowsProcessTreeKillArgs(pid) {
  return ["/pid", String(pid), "/t", "/f"];
}

function terminateProcessTree(childProcess) {
  if (!childProcess || childProcess.killed) {
    return;
  }

  if (process.platform !== "win32" || !childProcess.pid) {
    childProcess.kill();
    return;
  }

  const taskkill = cp.spawn("taskkill", buildWindowsProcessTreeKillArgs(childProcess.pid), {
    windowsHide: true,
    stdio: "ignore",
  });
  taskkill.on("error", () => {
    childProcess.kill();
  });
}

function buildServerArgs({ contentRoot, port }) {
  return [
    "run",
    "--native-tls",
    "python",
    "-m",
    "app.main",
    "--cd",
    contentRoot,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-reload",
    "--no-use-colors",
  ];
}

function spawnServer({ uvPath, serverRoot, contentRoot, port }) {
  const args = buildServerArgs({ contentRoot, port });
  appendOutput(`Starting server: ${uvPath} ${args.join(" ")}`);
  return cp.spawn(uvPath, args, {
    cwd: serverRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function ensureServer({ vscode, context, contentRoot }) {
  if (currentServer && currentServer.contentRoot === contentRoot) {
    return currentServer.port;
  }

  stopCurrentServer();

  const config = getConfiguration(vscode);
  const serverRoot = serverRootForExtension(context.extensionPath);
  if (!serverEntryExists(serverRoot)) {
    throw new Error(`Staged MD Activator server was not found at ${serverRoot}`);
  }

  await verifyRuntime({ uvPath: config.uvPath, serverRoot });

  const port = await findFreePort(config.portStart);
  const child = spawnServer({
    uvPath: config.uvPath,
    serverRoot,
    contentRoot,
    port,
  });

  child.stdout.on("data", (data) => appendOutput(String(data).trimEnd()));
  child.stderr.on("data", (data) => appendOutput(String(data).trimEnd()));
  child.on("exit", (code, signal) => {
    appendOutput(`Server exited with code ${code} signal ${signal}`);
    if (currentServer && currentServer.process === child) {
      currentServer = null;
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1200);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`MD Activator server exited before preview opened with code ${code}`));
    });
  });

  currentServer = { process: child, contentRoot, port };
  appendOutput(`Server ready on 127.0.0.1:${port} for ${contentRoot}`);
  return port;
}

async function openPreviewToSide(vscode, context, resourceUri) {
  const filePath = markdownFileForPreviewCommand(vscode, resourceUri);
  if (!filePath) {
    vscode.window.showErrorMessage("Open a markdown file before starting MD Activator preview.");
    return;
  }

  try {
    const target = resolvePreviewTarget(filePath, workspaceRoots(vscode));
    const port = await ensureServer({ vscode, context, contentRoot: target.contentRoot });
    const panel = vscode.window.createWebviewPanel(
      "mdActivatorPreview",
      `MD Activator: ${path.basename(filePath)}`,
      vscode.ViewColumn.Beside,
      buildWebviewOptions({ serverPort: port }),
    );

    panel.webview.html = buildWebviewHtml({
      webviewPort: port,
      relativePath: target.relativePath,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendOutput(detail);
    vscode.window.showErrorMessage(`Unable to open MD Activator preview: ${detail}`);
  }
}

function activate(context) {
  const vscode = getVscode();
  outputChannel = vscode.window.createOutputChannel("MD Activator");
  context.subscriptions.push(outputChannel);
  context.subscriptions.push(
    vscode.commands.registerCommand("mdActivator.openPreviewToSide", (resourceUri) =>
      openPreviewToSide(vscode, context, resourceUri),
    ),
  );
  context.subscriptions.push(vscode.commands.registerCommand("mdActivator.stopServer", stopCurrentServer));
}

function deactivate() {
  stopCurrentServer();
}

module.exports = {
  activate,
  deactivate,
  buildServerArgs,
  buildRuntimeCheckFailureMessage,
  buildRuntimeChecks,
  buildWindowsProcessTreeKillArgs,
  buildWebviewHtml,
  buildWebviewOptions,
  findFreePort,
  markdownFileForPreviewCommand,
  normalizePathForUrl,
  resolvePreviewTarget,
  terminateProcessTree,
};
