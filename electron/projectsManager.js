const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dialog, BrowserWindow } = require('electron');

// Projects: a named bundle of instructions plus reference files. A chat that
// belongs to a project gets the project's instructions and file contents
// folded into its system prompt. Layout on disk:
//   <userData>/projects/<id>/project.json      metadata, instructions, file list
//   <userData>/projects/<id>/files/<fileId>.txt extracted text of each file
//   <userData>/projects/<id>/files/<fileId>__<original name>  the upload itself

let appInstance = null;
let chatHistory = null;

const MAX_FILES_PER_PROJECT = 30;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Characters of file text folded into the prompt, per file and in total.
// ~4 chars per token: 300k chars is roughly 75k tokens of project knowledge.
const MAX_FILE_CHARS = 150000;
const MAX_CONTEXT_CHARS = 300000;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'tex', 'adoc', 'org',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'csv', 'tsv', 'xml', 'html', 'htm', 'svg', 'log',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'scala', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'graphql', 'gql', 'proto', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'lock',
]);

function initialize(app, chatHistoryManager) {
  appInstance = app;
  chatHistory = chatHistoryManager;
}

function getProjectsDir() {
  if (!appInstance) throw new Error('Projects manager not initialized');
  const dir = path.join(appInstance.getPath('userData'), 'projects');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[a-f0-9-]{36}$/i.test(projectId)) {
    throw new Error('Invalid project id');
  }
}

function getProjectDir(projectId) {
  assertProjectId(projectId);
  return path.join(getProjectsDir(), projectId);
}

function getProjectFilePath(projectId) {
  return path.join(getProjectDir(projectId), 'project.json');
}

function getProjectFilesDir(projectId) {
  const dir = path.join(getProjectDir(projectId), 'files');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readProjectFile(projectId) {
  const filePath = getProjectFilePath(projectId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`[Projects] Error reading project ${projectId}:`, error);
    return null;
  }
}

function writeProjectFile(project) {
  const dir = getProjectDir(project.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(getProjectFilePath(project.id), JSON.stringify(project, null, 2));
  return project;
}

function normalizeProject(raw) {
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Untitled project',
    description: typeof raw.description === 'string' ? raw.description : '',
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    overrideSystemPrompt: raw.overrideSystemPrompt === true,
    files: Array.isArray(raw.files) ? raw.files : [],
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** All projects, most recently updated first. File contents are not included. */
function listProjects() {
  const dir = getProjectsDir();
  const projects = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const raw = readProjectFile(entry.name);
      if (raw && raw.id === entry.name) projects.push(normalizeProject(raw));
    }
    projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch (error) {
    console.error('[Projects] Error listing projects:', error);
  }
  return projects;
}

function loadProject(projectId) {
  const raw = readProjectFile(projectId);
  return raw ? normalizeProject(raw) : null;
}

function createProject({ name, description } = {}) {
  const now = new Date().toISOString();
  const project = normalizeProject({
    id: crypto.randomUUID(),
    name,
    description,
    instructions: '',
    overrideSystemPrompt: false,
    files: [],
    createdAt: now,
    updatedAt: now,
  });
  writeProjectFile(project);
  getProjectFilesDir(project.id);
  return project;
}

const EDITABLE_FIELDS = ['name', 'description', 'instructions', 'overrideSystemPrompt'];

function updateProject(projectId, patch = {}) {
  const project = loadProject(projectId);
  if (!project) throw new Error('Project not found');
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) project[key] = patch[key];
  }
  return writeProjectFile(normalizeProject(project));
}

/** Remove a project, its files and every chat that belongs to it. */
function deleteProject(projectId) {
  const dir = getProjectDir(projectId);
  if (!fs.existsSync(dir)) return false;
  let deletedChats = 0;
  if (chatHistory && typeof chatHistory.deleteChatsForProject === 'function') {
    deletedChats = chatHistory.deleteChatsForProject(projectId);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[Projects] Deleted project ${projectId} and ${deletedChats} chats`);
  return true;
}

// --- File handling ---

function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-() ]+/g, '_');
  return base.slice(0, 120) || 'file';
}

function fileExtension(name) {
  const base = path.basename(String(name || '')).toLowerCase();
  if (!base.includes('.')) return base; // Dockerfile, Makefile
  return base.split('.').pop();
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

/**
 * Extract plain text from an uploaded file. PDFs and Word documents go
 * through their parsers; anything text-like is decoded as UTF-8.
 */
async function extractText(name, buffer) {
  const ext = fileExtension(name);
  if (ext === 'pdf') {
    const pdfParse = require('pdf-parse');
    const result = await pdfParse(buffer);
    return { text: result.text || '', kind: 'pdf', pages: result.numpages };
  }
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value || '', kind: 'docx' };
  }
  if (TEXT_EXTENSIONS.has(ext) || !looksBinary(buffer)) {
    return { text: buffer.toString('utf8'), kind: 'text' };
  }
  throw new Error(
    `"${path.basename(name)}" is not a supported file type. Add text files (.txt, .md, code, .csv, .json…), PDFs or Word .docx documents.`
  );
}

/**
 * Store an uploaded file in a project and index its text.
 * @param {string} projectId
 * @param {{name: string, type?: string, data: Buffer|Uint8Array|ArrayBuffer}} file
 */
async function addFile(projectId, file) {
  const project = loadProject(projectId);
  if (!project) throw new Error('Project not found');
  // Adding a file that is already in the project replaces it: two copies of
  // the same document would leave the model reading the outdated one too.
  const name = path.basename(String(file.name));
  const superseded = project.files.filter((f) => f.name === name);
  if (project.files.length - superseded.length >= MAX_FILES_PER_PROJECT) {
    throw new Error(`A project can hold at most ${MAX_FILES_PER_PROJECT} files.`);
  }
  const buffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`"${file.name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  }

  const { text, kind, pages } = await extractText(file.name, buffer);
  const cleaned = text.replace(/\r\n/g, '\n').split(' ').join('').trim();
  if (!cleaned) {
    throw new Error(`No readable text found in "${file.name}".`);
  }

  const fileId = crypto.randomUUID();
  const filesDir = getProjectFilesDir(projectId);
  for (const old of superseded) {
    for (const candidate of [old.storedName, `${old.id}.txt`]) {
      if (!candidate) continue;
      const target = path.join(filesDir, path.basename(candidate));
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }
  if (superseded.length) {
    project.files = project.files.filter((f) => f.name !== name);
    console.log(`[Projects] Replaced "${name}" in ${project.name} with the newly added copy`);
  }
  const storedName = `${fileId}__${safeFileName(file.name)}`;
  fs.writeFileSync(path.join(filesDir, storedName), buffer);
  fs.writeFileSync(path.join(filesDir, `${fileId}.txt`), cleaned);

  project.files.push({
    id: fileId,
    name,
    type: file.type || '',
    kind,
    size: buffer.length,
    chars: cleaned.length,
    ...(pages ? { pages } : {}),
    storedName,
    addedAt: new Date().toISOString(),
  });
  return writeProjectFile(project);
}

function removeFile(projectId, fileId) {
  const project = loadProject(projectId);
  if (!project) throw new Error('Project not found');
  const entry = project.files.find((f) => f.id === fileId);
  if (!entry) return project;
  const filesDir = getProjectFilesDir(projectId);
  for (const candidate of [entry.storedName, `${fileId}.txt`]) {
    if (!candidate) continue;
    const target = path.join(filesDir, path.basename(candidate));
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  project.files = project.files.filter((f) => f.id !== fileId);
  return writeProjectFile(project);
}

function readFileText(projectId, fileId) {
  const project = loadProject(projectId);
  if (!project) return null;
  const entry = project.files.find((f) => f.id === fileId);
  if (!entry) return null;
  const target = path.join(getProjectFilesDir(projectId), `${fileId}.txt`);
  if (!fs.existsSync(target)) return '';
  return fs.readFileSync(target, 'utf8');
}

// --- Prompt assembly ---

function truncateText(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[… truncated: ${text.length - limit} more characters not shown]`;
}

/**
 * The block of text a project contributes to the system prompt: its
 * instructions followed by the contents of its files. Empty string when the
 * project has neither.
 */
function buildProjectContext(project) {
  if (!project) return '';
  const sections = [];
  const instructions = (project.instructions || '').trim();
  if (instructions) {
    sections.push(`# Project: ${project.name}\n\n## Project instructions\n${instructions}`);
  } else {
    sections.push(`# Project: ${project.name}`);
  }

  if (project.files.length) {
    let budget = MAX_CONTEXT_CHARS;
    const fileBlocks = [];
    for (const entry of project.files) {
      let text = readFileText(project.id, entry.id) || '';
      if (!text.trim()) continue;
      const limit = Math.min(MAX_FILE_CHARS, budget);
      if (limit <= 0) {
        fileBlocks.push(`<file name="${entry.name}">\n[omitted: project knowledge limit reached]\n</file>`);
        continue;
      }
      text = truncateText(text, limit);
      budget -= text.length;
      fileBlocks.push(`<file name="${entry.name}">\n${text}\n</file>`);
    }
    if (fileBlocks.length) {
      sections.push(
        `## Project knowledge\nThe following files are attached to this project. Treat them as reference material for every reply.\n\n${fileBlocks.join('\n\n')}`
      );
    }
  }
  return sections.join('\n\n');
}

/**
 * Settings as the chat handlers should see them while a project is active:
 * the project's context goes into customSystemPrompt, either replacing the
 * prompt from Settings (override on) or following it (override off).
 */
function applyProjectToSettings(settings, projectId) {
  if (!projectId) return settings;
  let project = null;
  try {
    project = loadProject(projectId);
  } catch (error) {
    console.error('[Projects] Could not load project for chat:', error.message);
  }
  if (!project) return settings;

  const context = buildProjectContext(project);
  const base = (settings.customSystemPrompt || '').trim();
  const parts = [];
  if (!project.overrideSystemPrompt && base) parts.push(base);
  if (context) parts.push(context);
  return { ...settings, customSystemPrompt: parts.join('\n\n') };
}

// --- IPC ---

function initializeProjectHandlers(ipcMain) {
  ipcMain.handle('projects-list', async () => listProjects());
  ipcMain.handle('projects-get', async (event, projectId) => loadProject(projectId));
  ipcMain.handle('projects-create', async (event, data) => createProject(data || {}));
  ipcMain.handle('projects-update', async (event, projectId, patch) => updateProject(projectId, patch || {}));
  ipcMain.handle('projects-delete', async (event, projectId) => ({ success: deleteProject(projectId) }));
  ipcMain.handle('projects-remove-file', async (event, projectId, fileId) => removeFile(projectId, fileId));
  ipcMain.handle('projects-read-file', async (event, projectId, fileId) => readFileText(projectId, fileId));

  // Bytes handed over from the renderer (drag-and-drop)
  ipcMain.handle('projects-add-file', async (event, projectId, file) => {
    try {
      const project = await addFile(projectId, file);
      return { success: true, project };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Native open dialog; files are read straight from disk
  ipcMain.handle('projects-pick-files', async (event, projectId) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: 'Add files to project',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Documents & text', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'yaml', 'yml', 'xml', 'html'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) {
      return { success: true, canceled: true, project: loadProject(projectId), errors: [] };
    }
    const errors = [];
    let project = loadProject(projectId);
    for (const filePath of result.filePaths) {
      try {
        const data = fs.readFileSync(filePath);
        project = await addFile(projectId, { name: path.basename(filePath), data });
      } catch (error) {
        errors.push(error.message);
      }
    }
    return { success: errors.length === 0, project, errors };
  });
}

module.exports = {
  initialize,
  initializeProjectHandlers,
  listProjects,
  loadProject,
  createProject,
  updateProject,
  deleteProject,
  addFile,
  removeFile,
  readFileText,
  buildProjectContext,
  applyProjectToSettings,
  extractText,
};
