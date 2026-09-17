// SPDX-License-Identifier: BSD-3-Clause

import { createZip, readZip } from './zip.js';

function isJunkZipEntry(path) {
  if (!path) return true;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('__MACOSX/') || normalized.includes('/__MACOSX/')) return true;
  const segments = normalized.split('/');
  const filename = segments[segments.length - 1];
  if (!filename) return true;
  if (filename === '.DS_Store' || filename === 'Thumbs.db' || filename === 'desktop.ini') return true;
  if (filename.startsWith('._')) return true;
  return false;
}

function sanitizeProjectName(name) {
  if (!name) return 'project';
  let cleaned = name.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9_\-]/g, '_').trim();
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  if (!cleaned) cleaned = 'project';
  return cleaned.slice(0, 16);
}


export class StorageCoordinator {
  constructor() {
    this.fs = null;
    this.pendingGeneration = 0;
    this.syncedGeneration = 0;
    this.isSyncing = false;
    this.debounceTimer = null;
    this.state = 'idle'; // 'idle', 'saved', 'saving', 'error'
    this.lastError = null;
    this.listeners = new Set();
    this.lockRelease = null;
  }

  /**
   * Acquire a single-writer tab lock to prevent concurrent IDBFS writes across multiple tabs.
   * @returns {Promise<boolean>} True if lock acquired, false if another tab is active.
   */
  async acquireLock() {
    if (!navigator.locks) {
      // Browser does not support Web Locks API, proceed cautiously
      return true;
    }
    return new Promise((resolve) => {
      navigator.locks.request('picotracker-storage-lock', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        // Hold lock until released
        await new Promise((res) => {
          this.lockRelease = res;
        });
      }).catch((err) => {
        console.warn('[storage] Lock request error:', err);
        resolve(true); // Fail open if error
      });
    });
  }

  releaseLock() {
    if (this.lockRelease) {
      this.lockRelease();
      this.lockRelease = null;
    }
  }

  init(fsModule) {
    this.fs = fsModule;
    this.healProjects();
    this.state = 'saved';
    this._notify();
  }

  onStateChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn({
          state: this.state,
          pendingGeneration: this.pendingGeneration,
          syncedGeneration: this.syncedGeneration,
          hasUnsaved: this.pendingGeneration > this.syncedGeneration,
          error: this.lastError
        });
      } catch (e) {
        console.error('[storage] Listener error:', e);
      }
    }
  }

  /**
   * Called by C++ WasmStorage_FlushMutationNotifications when files are written or deleted.
   */
  notifyMutation() {
    this.pendingGeneration++;
    if (this.state !== 'saving') {
      this.state = 'saving';
      this._notify();
    }
    this._scheduleSync();
  }

  _scheduleSync() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, 400);
  }

  /**
   * Performs an asynchronous FS.syncfs(false) to persist MEMFS to IDBFS.
   */
  async flush() {
    if (!this.fs) return;
    if (this.isSyncing) return;
    if (this.pendingGeneration === this.syncedGeneration) {
      if (this.state !== 'saved') {
        this.state = 'saved';
        this._notify();
      }
      return;
    }

    const syncGen = this.pendingGeneration;
    this.isSyncing = true;
    this.state = 'saving';
    this._notify();

    return new Promise((resolve) => {
      this.fs.syncfs(false, (err) => {
        this.isSyncing = false;
        if (err) {
          console.error('[storage] IDBFS sync error:', err);
          this.state = 'error';
          this.lastError = err.message || String(err);
          this._notify();
          resolve(false);
        } else {
          this.syncedGeneration = syncGen;
          this.lastError = null;
          if (this.pendingGeneration > this.syncedGeneration) {
            // New mutations arrived during sync; schedule follow-up
            this._scheduleSync();
          } else {
            this.state = 'saved';
            this._notify();
          }
          resolve(true);
        }
      });
    });
  }

  /**
   * Recursive directory listing inside Emscripten FS.
   */
  _readDirectoryRecursive(dirPath) {
    if (!this.fs) return [];
    const results = [];
    const entries = this.fs.readdir(dirPath);
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const fullPath = `${dirPath}/${name}`.replace(/\/+/g, '/');
      try {
        const stat = this.fs.stat(fullPath);
        if (this.fs.isDir(stat.mode)) {
          results.push(...this._readDirectoryRecursive(fullPath));
        } else {
          results.push(fullPath);
        }
      } catch (e) {
        console.warn(`[storage] Stat failed for ${fullPath}:`, e);
      }
    }
    return results;
  }

  /**
   * Installs an embedded project into a new browser storage database and makes
   * it the current project. Existing storage is never modified by this seed.
   * @param {string} projectName
   * @param {string} sourceDir
   * @returns {boolean} True when the project was installed
   */
  seedDefaultProject(projectName, sourceDir) {
    if (!this.fs) return false;

    const projectsPath = '/data/projects';
    const currentProjectPath = '/data/.current';
    const projectDir = `${projectsPath}/${projectName}`;

    try {
      // Never overwrite if the project already exists
      if (this.fs.analyzePath(projectDir).exists) {
        return false;
      }

      // Check current project marker: if it points to a real user project, preserve it
      if (this.fs.analyzePath(currentProjectPath).exists) {
        try {
          const currentName = this.fs.readFile(currentProjectPath, { encoding: 'utf8' }).trim();
          if (currentName !== '' && currentName !== '.untitled' && currentName !== projectName) {
            return false;
          }
        } catch (_) {}
      }

      // Check existing projects: only seed if no projects or only placeholder .untitled exists
      if (this.fs.analyzePath(projectsPath).exists) {
        const existingProjects = this.fs.readdir(projectsPath)
          .filter((name) => name !== '.' && name !== '..');
        const userProjects = existingProjects.filter((name) => name !== '.untitled');
        if (userProjects.length > 0) {
          return false;
        }
      }

      if (!this.fs.analyzePath(`${sourceDir}/ptsav.dat`).exists) {
        throw new Error(`Default project is missing ${sourceDir}/ptsav.dat`);
      }

      // If .untitled exists as the only placeholder project, remove it so default project replaces it
      const untitledPath = `${projectsPath}/.untitled`;
      if (this.fs.analyzePath(untitledPath).exists) {
        try {
          this._removeDirectoryRecursive(untitledPath);
        } catch (err) {
          console.warn('[storage] Failed to clean up .untitled:', err);
        }
      }

      const sourceFiles = this._readDirectoryRecursive(sourceDir);
      this._ensureDir(projectDir);
      for (const sourceFile of sourceFiles) {
        const relativePath = sourceFile.slice(sourceDir.length + 1);
        const destination = `${projectDir}/${relativePath}`;
        const destinationParent = destination.substring(0, destination.lastIndexOf('/'));
        this._ensureDir(destinationParent);
        const data = this.fs.readFile(sourceFile, { encoding: 'binary' });
        this.fs.writeFile(destination, data);
      }
      this.fs.writeFile(currentProjectPath, projectName);
      this.notifyMutation();
      return true;
    } catch (e) {
      console.error('[storage] Failed to install default project:', e);
      try {
        if (this.fs.analyzePath(currentProjectPath).exists) {
          this.fs.unlink(currentProjectPath);
        }
        if (this.fs.analyzePath(projectDir).exists) {
          this._removeDirectoryRecursive(projectDir);
        }
      } catch (_) {}
      return false;
    }
  }

  /**
   * Scans /data/projects, flattens nested project directories created by earlier
   * import flaws, cleans out OS metadata junk, and enforces the 16-character limit.
   * @returns {boolean} True if any repairs were made
   */
  healProjects() {
    if (!this.fs) return false;
    const projectsPath = '/data/projects';
    try {
      if (!this.fs.analyzePath(projectsPath).exists) return false;
    } catch (_) {
      return false;
    }

    let modified = false;
    try {
      const entries = this.fs.readdir(projectsPath);
      for (let name of entries) {
        if (name === '.' || name === '..') continue;
        const fullPath = `${projectsPath}/${name}`;
        let stat;
        try {
          stat = this.fs.stat(fullPath);
        } catch (_) {
          continue;
        }
        if (!this.fs.isDir(stat.mode)) continue;

        // Clean macOS / OS junk inside project directory
        try {
          if (this.fs.analyzePath(`${fullPath}/__MACOSX`).exists) {
            this._removeDirectoryRecursive(`${fullPath}/__MACOSX`);
            modified = true;
          }
          if (this.fs.analyzePath(`${fullPath}/.DS_Store`).exists) {
            this.fs.unlink(`${fullPath}/.DS_Store`);
            modified = true;
          }
        } catch (_) {}

        let hasPtsav = false;
        try {
          hasPtsav = this.fs.analyzePath(`${fullPath}/ptsav.dat`).exists;
        } catch (_) {}

        // If ptsav.dat is not at top level, check for nested project directory
        if (!hasPtsav) {
          const subEntries = this.fs.readdir(fullPath);
          let foundNested = null;
          for (const sub of subEntries) {
            if (sub === '.' || sub === '..' || sub === '__MACOSX') continue;
            const subPath = `${fullPath}/${sub}`;
            try {
              const subStat = this.fs.stat(subPath);
              if (this.fs.isDir(subStat.mode)) {
                if (this.fs.analyzePath(`${subPath}/ptsav.dat`).exists) {
                  foundNested = sub;
                  break;
                }
              }
            } catch (_) {}
          }

          if (foundNested) {
            const nestedDir = `${fullPath}/${foundNested}`;
            const nestedFiles = this._readDirectoryRecursive(nestedDir);
            for (const file of nestedFiles) {
              const rel = file.slice(nestedDir.length + 1);
              const dest = `${fullPath}/${rel}`;
              const destParent = dest.substring(0, dest.lastIndexOf('/'));
              this._ensureDir(destParent);
              const data = this.fs.readFile(file, { encoding: 'binary' });
              this.fs.writeFile(dest, data);
            }
            this._removeDirectoryRecursive(nestedDir);

            if (name.startsWith('imported_')) {
              const targetName = sanitizeProjectName(foundNested);
              if (targetName !== name && !this.fs.analyzePath(`${projectsPath}/${targetName}`).exists) {
                this.fs.rename(fullPath, `${projectsPath}/${targetName}`);
                name = targetName;
              }
            }
            try {
              hasPtsav = this.fs.analyzePath(`${projectsPath}/${name}/ptsav.dat`).exists;
            } catch (_) {}
            modified = true;
          }
        }

        const currentProjPath = `${projectsPath}/${name}`;
        if (hasPtsav && name.length > 16) {
          const validName = sanitizeProjectName(name);
          if (validName !== name) {
            const destPath = `${projectsPath}/${validName}`;
            if (!this.fs.analyzePath(destPath).exists) {
              this.fs.rename(currentProjPath, destPath);
              modified = true;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[storage] Error during healProjects:', e);
    }
    if (modified) {
      this.notifyMutation();
    }
    return modified;
  }

  /**
   * Lists all projects in /data/projects.
   */
  listProjects() {
    if (!this.fs) return [];
    this.healProjects();
    const projectsPath = '/data/projects';
    try {
      if (!this.fs.analyzePath(projectsPath).exists) {
        return [];
      }
      const entries = this.fs.readdir(projectsPath);
      const projects = [];
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        const fullPath = `${projectsPath}/${name}`;
        const stat = this.fs.stat(fullPath);
        if (this.fs.isDir(stat.mode)) {
          // Check if it has ptsav.dat (Advance project marker)
          let hasDat = false;
          try {
            hasDat = this.fs.analyzePath(`${fullPath}/ptsav.dat`).exists;
          } catch (_) {}
          projects.push({
            name,
            hasDat,
            path: fullPath
          });
        }
      }
      return projects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.warn('[storage] Failed to list projects:', e);
      return [];
    }
  }


  /**
   * Lists all WAV files in /data/renders.
   */
  listRenders() {
    if (!this.fs) return [];
    const rendersPath = '/data/renders';
    try {
      if (!this.fs.analyzePath(rendersPath).exists) {
        return [];
      }
      const entries = this.fs.readdir(rendersPath);
      const renders = [];
      for (const name of entries) {
        if (name === '.' || name === '..') continue;
        if (!name.toLowerCase().endsWith('.wav')) continue;
        const fullPath = `${rendersPath}/${name}`;
        const stat = this.fs.stat(fullPath);
        if (!this.fs.isDir(stat.mode)) {
          renders.push({
            name,
            size: stat.size,
            path: fullPath
          });
        }
      }
      return renders.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.warn('[storage] Failed to list renders:', e);
      return [];
    }
  }

  /**
   * Packages a project folder into a ZIP file.
   * @param {string} projectName
   * @returns {Promise<Uint8Array>}
   */
  async exportProjectZip(projectName) {
    if (!this.fs) throw new Error('Filesystem not initialized');
    const projectDir = `/data/projects/${projectName}`;
    if (!this.fs.analyzePath(projectDir).exists) {
      throw new Error(`Project ${projectName} does not exist`);
    }

    const filePaths = this._readDirectoryRecursive(projectDir);
    const zipEntries = [];
    for (const filePath of filePaths) {
      const relPath = filePath.slice(projectDir.length + 1);
      const content = this.fs.readFile(filePath, { encoding: 'binary' });
      zipEntries.push({ path: `${projectName}/${relPath}`, data: content });
    }

    return await createZip(zipEntries);
  }

  /**
   * Imports a project from a ZIP file into /data/projects.
   * Requires ptsav.dat to be present in the project.
   * @param {ArrayBuffer|Uint8Array} zipBuffer
   * @param {string} [originalFileName='']
   * @returns {Promise<string>} Imported project name
   */
  async importProjectZip(zipBuffer, originalFileName = '') {
    if (!this.fs) throw new Error('Filesystem not initialized');
    const entries = await readZip(zipBuffer);
    if (entries.length === 0) {
      throw new Error('ZIP archive is empty');
    }

    const validEntries = entries.filter((e) => !isJunkZipEntry(e.path));
    if (validEntries.length === 0) {
      throw new Error('ZIP archive contains no usable project files');
    }

    // Require ptsav.dat (Advance project marker)
    const markerEntry = validEntries.find((e) => {
      const p = e.path.replace(/\\/g, '/');
      return p === 'ptsav.dat' || p.endsWith('/ptsav.dat');
    });

    if (!markerEntry) {
      throw new Error('Invalid picoTracker project: ptsav.dat not found in archive');
    }

    const markerPath = markerEntry.path.replace(/\\/g, '/');
    const lastSlash = markerPath.lastIndexOf('/');
    let projectPrefix = '';
    let rawName = '';

    if (lastSlash >= 0) {
      projectPrefix = markerPath.substring(0, lastSlash + 1);
      const segments = projectPrefix.slice(0, -1).split('/');
      rawName = segments[segments.length - 1];
    } else {
      projectPrefix = '';
      rawName = originalFileName.replace(/\.zip$/i, '');
    }

    const projectName = sanitizeProjectName(rawName);
    const projectDir = `/data/projects/${projectName}`;
    this._ensureDir(projectDir);

    for (const entry of validEntries) {
      const path = entry.path.replace(/\\/g, '/');
      if (projectPrefix && !path.startsWith(projectPrefix)) {
        continue;
      }
      const relPath = projectPrefix ? path.slice(projectPrefix.length) : path;
      if (!relPath || relPath.endsWith('/')) continue;

      const targetPath = `${projectDir}/${relPath}`;
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      this._ensureDir(parentDir);
      this.fs.writeFile(targetPath, entry.data);
    }

    this.notifyMutation();
    await this.flush();
    return projectName;
  }


  /**
   * Packages the entire /data directory into a full backup ZIP.
   * @returns {Promise<Uint8Array>}
   */
  async exportFullBackupZip() {
    if (!this.fs) throw new Error('Filesystem not initialized');
    const filePaths = this._readDirectoryRecursive('/data');
    const zipEntries = [];
    for (const filePath of filePaths) {
      const relPath = filePath.slice('/data/'.length);
      const content = this.fs.readFile(filePath, { encoding: 'binary' });
      zipEntries.push({ path: relPath, data: content });
    }
    return await createZip(zipEntries);
  }

  /**
   * Restores /data from a full backup ZIP.
   * @param {ArrayBuffer|Uint8Array} zipBuffer
   */
  async restoreFullBackupZip(zipBuffer) {
    if (!this.fs) throw new Error('Filesystem not initialized');
    const entries = await readZip(zipBuffer);
    for (const entry of entries) {
      const targetPath = `/data/${entry.path}`;
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
      this._ensureDir(parentDir);
      this.fs.writeFile(targetPath, entry.data);
    }
    this.notifyMutation();
    await this.flush();
  }

  /**
   * Reads a rendered audio file as a Blob.
   * @param {string} filename
   * @returns {Blob}
   */
  getRenderBlob(filename) {
    if (!this.fs) throw new Error('Filesystem not initialized');
    const fullPath = `/data/renders/${filename}`;
    const data = this.fs.readFile(fullPath, { encoding: 'binary' });
    return new Blob([data], { type: 'audio/wav' });
  }

  /**
   * Deletes a render file.
   * @param {string} filename
   */
  deleteRender(filename) {
    if (!this.fs) return;
    const fullPath = `/data/renders/${filename}`;
    try {
      this.fs.unlink(fullPath);
      this.notifyMutation();
    } catch (e) {
      console.warn(`[storage] Delete render failed for ${fullPath}:`, e);
    }
  }

  /**
   * Deletes a project directory recursively.
   * @param {string} projectName
   */
  deleteProject(projectName) {
    if (!this.fs) return;
    const projectDir = `/data/projects/${projectName}`;
    try {
      if (this.fs.analyzePath(projectDir).exists) {
        this._removeDirectoryRecursive(projectDir);
        this.notifyMutation();
      }
    } catch (e) {
      console.warn(`[storage] Delete project failed for ${projectDir}:`, e);
    }
  }

  _removeDirectoryRecursive(dirPath) {
    if (!this.fs) return;
    const entries = this.fs.readdir(dirPath);
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      const fullPath = `${dirPath}/${name}`;
      const stat = this.fs.stat(fullPath);
      if (this.fs.isDir(stat.mode)) {
        this._removeDirectoryRecursive(fullPath);
      } else {
        this.fs.unlink(fullPath);
      }
    }
    this.fs.rmdir(dirPath);
  }

  _ensureDir(dirPath) {
    const parts = dirPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      if (!this.fs.analyzePath(current).exists) {
        try {
          this.fs.mkdir(current);
        } catch (_) {}
      }
    }
  }
}

export const storage = new StorageCoordinator();
