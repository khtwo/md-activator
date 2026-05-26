# MD Activator VS Code Extension Package

This folder contains the local VSIX package for installing MD Activator in VS Code.

## Contents

- `md-activator-0.1.2.vsix`: VS Code extension package. It includes the extension code, icon, metadata, and bundled MD Activator server runtime.
- `README.md`: install and runtime notes for this package.

## Requirements

- VS Code desktop 1.66.0 or newer.
- Python 3.11 or newer installed on the user's machine.
- `uv` installed and available on `PATH`, or configured in VS Code setting `mdActivator.uvPath`.

Python and `uv` are not bundled in the VSIX. On first preview, the extension uses `uv` to prepare the staged Python environment from the packaged server runtime.

## Install in VS Code

1. Open VS Code.
2. Open Extensions.
3. Select `...` > `Install from VSIX...`.
4. Choose `md-activator-0.1.2.vsix` from this folder.
5. Reload VS Code if prompted.
6. Open a `.md` file and click the MD Activator preview icon in the editor title.

Command-line install from this folder:

```powershell
code --install-extension .\md-activator-0.1.2.vsix --force
```

## Verify

Expected package:

```text
Name: md-activator-0.1.2.vsix
Version: 0.1.2
Publisher: khtwo
Repository: https://github.com/khtwo/md-activator
SHA256: B24FB783D363845588F5C7E63DD761C80F526AB83E68E7601FD9954A91CA6992
```
