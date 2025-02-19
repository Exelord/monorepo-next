'use strict';

const packlist = require('npm-packlist');
const path = require('path');
const { createTmpDir } = require('./tmp');
const fs = { ...require('fs'), ...require('fs').promises };
const Set = require('superset');
const { createPatch } = require('rfc6902');
const {
  getFileAtCommit,
} = require('./git');

const filesContributingToReleasability = new Set([
  '.gitignore',
  '.npmignore',
  'package.json',
]);

const packageJsonDevChangeRegex = /^\/(?:devDependencies|publishConfig)(?:\/|$)/m;

const relativePathRegex = /^\.{2}(?:\/|\\|$)/;

function removeSubDirs(files) {
  let remainingFiles = new Set(files);

  for (let file of remainingFiles) {
    let isSubDir = remainingFiles.some(nextFile => {
      if (file === nextFile) {
        return false;
      }

      let isSubDir = nextFile.startsWith(file);

      return isSubDir;
    });

    if (isSubDir) {
      remainingFiles.delete(file);
    }
  }

  return remainingFiles;
}

async function prepareTmpPackage({
  cwd,
  tmpDir,
  changedFiles,
}) {
  for (let fileName of filesContributingToReleasability) {
    let from = path.join(cwd, fileName);
    let to = path.join(tmpDir, fileName);

    await fs.mkdir(path.dirname(to), { recursive: true });

    try {
      await fs.copyFile(from, to);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  let remainingFiles = changedFiles.diff(filesContributingToReleasability);

  remainingFiles = removeSubDirs(remainingFiles);

  for (let file of remainingFiles) {
    let filePath = path.join(tmpDir, file);

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let text;

    if (path.basename(filePath) === 'package.json') {
      // removed packages will still match the root package.json's workspaces
      // and packlist will throw if they aren't readable.
      text = JSON.stringify({});
    } else {
      text = '';
    }

    await fs.writeFile(filePath, text);
  }
}

// We need to check the changed files rather than
// what is on disk. A published file could be removed,
// but it wouldn't look like a new version is needed
// because it's no longer on disk.
async function _getChangedReleasableFiles({
  cwd,
  changedFiles,
}) {
  let tmpDir = await createTmpDir();

  // This is all because `npm-packlist`/`ignore-walk`
  // doesn't accept a list of files instead of walking.
  await prepareTmpPackage({
    cwd,
    tmpDir,
    changedFiles,
  });

  let changedPublishedFiles = await packlist({ path: tmpDir });

  let changedPublishedFilesOld = new Set(changedPublishedFiles);

  let changedPublishedFilesNew = new Set();

  for (let file of changedFiles) {
    if (changedPublishedFilesOld.has(file)) {
      changedPublishedFilesNew.add(file);
    }

    // these files may not show up in the bundle, but
    // contribute to what goes in the bundle, so we must preserve
    // the changed status to know if the package is invalidated or not
    if (filesContributingToReleasability.has(file)) {
      changedPublishedFilesNew.add(file);
    }
  }

  changedPublishedFilesNew = changedPublishedFilesOld
    .union(filesContributingToReleasability)
    .intersect(changedFiles);

  return changedPublishedFilesNew;
}

async function isPackageJsonChangeReleasable({
  relativePackageJsonPath,
  fromCommit,
  workspacesCwd,
}) {
  let newPackageJson = JSON.parse(await fs.readFile(path.join(workspacesCwd, relativePackageJsonPath)));

  let oldPackageJson = JSON.parse(await getFileAtCommit(relativePackageJsonPath, fromCommit, workspacesCwd));

  let patch = createPatch(oldPackageJson, newPackageJson);

  let changesAffectingRelease = patch.filter(({ path }) => {
    let isMatch = packageJsonDevChangeRegex.test(path);

    return !isMatch;
  });

  return !!changesAffectingRelease.length;
}

async function getChangedReleasableFiles({
  changedFiles,
  packageCwd,
  workspacesCwd,
  shouldExcludeDevChanges,
  fromCommit,
}) {
  changedFiles = new Set(changedFiles);

  for (let changedFile of changedFiles) {
    if (changedFile.endsWith(path.sep)) {
      throw new Error(`expected '${changedFile}' to be a file, but it is a directory`);
    }
  }

  let changedPublishedFiles = await _getChangedReleasableFiles({
    cwd: packageCwd,
    changedFiles: changedFiles.map(file => path.relative(packageCwd, path.join(workspacesCwd, file))),
  });

  let relative = path.relative(workspacesCwd, packageCwd);

  changedPublishedFiles = changedPublishedFiles.map(file => path.join(relative, file));

  if (shouldExcludeDevChanges) {
    let relativePackageJsonPath = path.join(relative, 'package.json');

    if (changedPublishedFiles.has(relativePackageJsonPath)) {
      let _isPackageJsonChangeReleasable = await isPackageJsonChangeReleasable({
        relativePackageJsonPath,
        fromCommit,
        workspacesCwd,
      });

      if (!_isPackageJsonChangeReleasable) {
        changedPublishedFiles.delete(relativePackageJsonPath);
      }
    }
  }

  return Array.from(changedPublishedFiles).sort();
}

module.exports = {
  getChangedReleasableFiles,
  packageJsonDevChangeRegex,
  removeSubDirs,
  relativePathRegex,
};
