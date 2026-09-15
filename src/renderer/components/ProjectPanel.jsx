import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useChat } from '../context/ChatContext';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import Switch from './ui/Switch';
import {
  FileText,
  Upload,
  X,
  FolderOpen,
  BookOpen,
  Loader2,
  AlertCircle,
  Check,
} from 'lucide-react';

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function approxTokens(chars) {
  const tokens = Math.round((chars || 0) / 4);
  if (tokens < 1000) return `${tokens} tokens`;
  return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k tokens`;
}

/**
 * Instructions, the override switch and the file list of one project.
 * Instructions autosave; files can be picked natively or dropped in.
 */
export function ProjectKnowledgePanel({ project }) {
  const { updateProject, pickProjectFiles, addProjectFile, removeProjectFile } = useChat();

  const [instructions, setInstructions] = useState(project?.instructions || '');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved
  const [fileError, setFileError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const saveTimer = useRef(null);
  const latestInstructions = useRef(project?.instructions || '');
  const lastSaved = useRef(project?.instructions || '');
  const projectId = project?.id;

  // Switching projects swaps the text under the editor
  useEffect(() => {
    const text = project?.instructions || '';
    setInstructions(text);
    latestInstructions.current = text;
    lastSaved.current = text;
    setSaveState('idle');
    setFileError(null);
  }, [projectId]);

  const persistInstructions = useCallback(async (text) => {
    if (!projectId || text === lastSaved.current) {
      setSaveState('idle');
      return;
    }
    try {
      setSaveState('saving');
      await updateProject(projectId, { instructions: text });
      lastSaved.current = text;
      setSaveState('saved');
      setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch (error) {
      console.error('Error saving project instructions:', error);
      setSaveState('idle');
    }
  }, [projectId, updateProject]);

  const handleInstructionsChange = (e) => {
    const text = e.target.value;
    setInstructions(text);
    latestInstructions.current = text;
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persistInstructions(text), 600);
  };

  // Flush a pending edit when the panel goes away
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      if (projectId && latestInstructions.current !== lastSaved.current) {
        updateProject(projectId, { instructions: latestInstructions.current }).catch(() => {});
      }
    };
  }, [projectId, updateProject]);

  const handleOverrideToggle = async (e) => {
    try {
      await updateProject(projectId, { overrideSystemPrompt: e.target.checked });
    } catch (error) {
      console.error('Error updating project:', error);
    }
  };

  const handlePickFiles = async () => {
    setFileError(null);
    setBusy(true);
    try {
      const result = await pickProjectFiles(projectId);
      if (result?.errors?.length) setFileError(result.errors.join('\n'));
    } catch (error) {
      setFileError(error.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = Array.from(e.dataTransfer?.files || []);
    if (!dropped.length) return;
    setFileError(null);
    setBusy(true);
    const errors = [];
    for (const file of dropped) {
      try {
        const buffer = await file.arrayBuffer();
        const result = await addProjectFile(projectId, {
          name: file.name,
          type: file.type,
          data: new Uint8Array(buffer),
        });
        if (!result?.success) errors.push(result?.error || `Could not add "${file.name}".`);
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (errors.length) setFileError(errors.join('\n'));
    setBusy(false);
  };

  const handleRemoveFile = async (fileId) => {
    try {
      await removeProjectFile(projectId, fileId);
    } catch (error) {
      setFileError(error.message);
    }
  };

  if (!project) return null;

  const files = project.files || [];
  const totalChars = files.reduce((sum, f) => sum + (f.chars || 0), 0);

  return (
    <div
      className={`glass-card rounded-xl p-5 space-y-6 transition-colors ${dragOver ? 'ring-2 ring-primary/60' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Instructions */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor={`project-instructions-${project.id}`} className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            Project instructions
          </Label>
          <span className="text-xs text-muted-foreground flex items-center gap-1 h-4">
            {saveState === 'saving' && (<><Loader2 className="h-3 w-3 animate-spin" /> Saving</>)}
            {saveState === 'saved' && (<><Check className="h-3 w-3" /> Saved</>)}
          </span>
        </div>
        <Textarea
          id={`project-instructions-${project.id}`}
          value={instructions}
          onChange={handleInstructionsChange}
          rows={6}
          placeholder="How should the model behave in this project? Tone, format, what to focus on, what to avoid…"
          className="min-h-[140px] bg-background/60"
        />
        <p className="text-xs text-muted-foreground">
          Sent as part of the system prompt for every chat in this project.
        </p>
      </div>

      {/* Override switch */}
      <div className="flex items-start justify-between gap-4 border border-border/50 rounded-lg px-3 py-3">
        <div className="space-y-1">
          <Label htmlFor={`project-override-${project.id}`} className="font-medium">
            Override system prompt
          </Label>
          <p className="text-xs text-muted-foreground">
            {project.overrideSystemPrompt
              ? 'On: the custom system prompt from Settings is replaced by these instructions.'
              : 'Off: the custom system prompt from Settings is sent first, then these instructions.'}
          </p>
        </div>
        <Switch
          id={`project-override-${project.id}`}
          checked={project.overrideSystemPrompt || false}
          onChange={handleOverrideToggle}
        />
      </div>

      {/* Files */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Project files
            </Label>
            <p className="text-xs text-muted-foreground mt-1">
              {files.length === 0
                ? 'Text, Markdown, code, CSV, JSON, PDF or Word files. Their text is given to the model.'
                : `${files.length} file${files.length === 1 ? '' : 's'} · about ${approxTokens(totalChars)} of context`}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handlePickFiles} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            Add files
          </Button>
        </div>

        {fileError && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2 whitespace-pre-line">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{fileError}</span>
          </div>
        )}

        {files.length === 0 ? (
          <div
            className={`border border-dashed rounded-lg px-4 py-6 text-center text-sm text-muted-foreground ${
              dragOver ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            Drop files here or use “Add files”
          </div>
        ) : (
          <ul className="space-y-1.5">
            {files.map((file) => (
              <li
                key={file.id}
                className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2"
              >
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate" title={file.name}>{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                    {file.pages ? ` · ${file.pages} page${file.pages === 1 ? '' : 's'}` : ''}
                    {` · ${approxTokens(file.chars)}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveFile(file.id)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title="Remove file"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Create a project, or edit an existing one's name and description. */
export function ProjectModal({ mode = 'create', project = null, onClose }) {
  const { createProject, updateProject } = useChat();
  const [name, setName] = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the project a name.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'edit' && project) {
        await updateProject(project.id, { name: trimmed, description: description.trim() });
      } else {
        await createProject({ name: trimmed, description: description.trim() });
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-background/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form onSubmit={handleSubmit} className="glass-card rounded-xl w-full max-w-md">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <FolderOpen className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">
            {mode === 'edit' ? 'Edit project' : 'New project'}
          </h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Interview prep, Q3 launch, Thesis"
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={3}
              className="min-h-[72px]"
              maxLength={400}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="p-4 border-t border-border bg-muted/30 flex justify-end gap-2 rounded-b-xl">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {mode === 'edit' ? 'Save' : 'Create project'}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** The knowledge panel in a modal, for tweaking a project mid-chat. */
export function ProjectKnowledgeModal({ project, onClose, onEdit }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!project) return null;

  return (
    <div
      className="fixed inset-0 bg-background/85 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-card rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="p-4 border-b border-border flex items-center gap-3">
          <FolderOpen className="h-5 w-5 text-primary flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold truncate">{project.name}</h2>
            {project.description && (
              <p className="text-sm text-muted-foreground truncate">{project.description}</p>
            )}
          </div>
          {onEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4 overflow-y-auto">
          <ProjectKnowledgePanel project={project} />
        </div>
      </div>
    </div>
  );
}
