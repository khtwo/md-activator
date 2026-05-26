const fs = require("node:fs");
const path = require("node:path");

const DIRECTORIES = ["app", "to-html"];
const FILES = [
  "pyproject.toml",
  "uv.lock",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "start_md.bat",
  "start_md.sh",
];

function removeDirectory(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function ensureDirectory(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyDirectory(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const name = path.basename(sourcePath);
      return name !== "__pycache__" && !sourcePath.endsWith(".pyc");
    },
  });
}

function copyFile(source, destination) {
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function requireExisting(source) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing required runtime path: ${source}`);
  }
}

function stageServer({ repoRoot, extensionRoot }) {
  const serverRoot = path.join(extensionRoot, "server");
  removeDirectory(serverRoot);
  ensureDirectory(serverRoot);

  for (const directory of DIRECTORIES) {
    const source = path.join(repoRoot, directory);
    requireExisting(source);
    copyDirectory(source, path.join(serverRoot, directory));
  }

  for (const file of FILES) {
    const source = path.join(repoRoot, file);
    requireExisting(source);
    copyFile(source, path.join(serverRoot, file));
  }
}

function main() {
  const extensionRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(extensionRoot, "..");
  stageServer({ repoRoot, extensionRoot });
  console.log(`Staged MD Activator server runtime in ${path.join(extensionRoot, "server")}`);
}

if (require.main === module) {
  main();
}

module.exports = { stageServer };
