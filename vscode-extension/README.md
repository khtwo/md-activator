# MD Activator for VS Code

Preview MD Activator markdown beside the VS Code editor.

MD Activator renders local markdown through the existing local FastAPI app and browser UI. It supports Mermaid diagrams, interactive task checkboxes, editable fenced code blocks, file navigation, images, and local write-back behavior.

## Usage

1. Open a `.md` file in VS Code desktop.
2. Click the MD Activator preview icon in the editor title.
3. Keep editing source markdown on the left while the rendered preview opens beside it.

The extension starts a local server bound to `127.0.0.1` on a dynamic private port. It uses the workspace folder as the content root, or the markdown file's parent folder for standalone files.
On first preview, `uv run` may spend a few seconds creating or synchronizing the staged Python environment bundled with the extension.

## Local Install

From the repository root:

```powershell
.\vsix_package.bat
code --install-extension .\vscode-extension\vsix-package\md-activator-0.1.7.vsix --force
```

The packaging helper installs the root frontend build dependencies, builds the local maxGraph adapter bundle, installs the extension packaging dependencies, and writes the versioned VSIX into `vscode-extension\vsix-package\`.

After installation, reload VS Code and open a markdown file.

## Requirements

- VS Code desktop 1.66.0 or newer.
- Python 3.11+ supported by MD Activator.
- `uv` available on `PATH`, or configured through `mdActivator.uvPath`.

When a preview starts, the extension checks `uv --version` and `uv run --native-tls python --version` before launching the server. Missing runtime setup is reported in VS Code, with command details in the `MD Activator` output channel.

## Settings

- `mdActivator.portStart`: first localhost port to try. Defaults to `49152`.
- `mdActivator.uvPath`: command or absolute path for `uv`. Defaults to `uv`.

## Commands

- `MD Activator: Open MD Activator Preview`
- `MD Activator: Stop MD Activator Server`

## Notes

The first version targets VS Code desktop. VS Code Web and browser-only Codespaces are not supported because this extension launches a local Python server.

Marketplace publishing is intentionally deferred until the local VSIX workflow is validated.
