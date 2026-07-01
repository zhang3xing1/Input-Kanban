import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './utils.js';

export const JOB_PACKAGE_SCHEMA = 'input-kanban.job.v1';
export const JOB_PACKAGE_VERSION = 1;

export function roleForTaskId(taskId) {
  if (taskId === 'planner') return 'planner';
  if (taskId === 'judge') return 'judge';
  return 'worker';
}

export function standaloneArtifactContract() {
  return {
    root: '.',
    files: {
      prompt: 'prompt.md',
      events: 'events.jsonl',
      timedEvents: 'events_timed.jsonl',
      stderr: 'stderr.log',
      lastMessage: 'last_message.md',
      exitCode: 'exit_code',
      result: 'result.json',
      evidence: 'evidence.json',
      verdict: 'verdict.json',
      judgeInput: 'judge_input.json',
      tmuxMetadata: 'tmux.json',
      job: 'package/job.json',
      jobEvents: 'package/job_events.jsonl',
      manifest: 'package/manifest.json'
    }
  };
}

export function createStandaloneJobSpec({
  runId,
  taskId,
  batchId = null,
  role = roleForTaskId(taskId),
  prompt,
  sandbox,
  cwd,
  outDir,
  runner,
  agentRuntime = 'codex',
  skipGitRepoCheck = false,
  expectedArtifacts = [],
  attempt = 1,
  retry = null,
  workspace = null,
  security = null
}) {
  const workspaceRef = workspace && typeof workspace === 'object'
    ? { type: 'localPath', path: cwd, ...workspace }
    : { type: 'localPath', path: cwd };
  const securityPolicy = security && typeof security === 'object'
    ? { sandbox, network: 'inherit', secrets: [], allowedPaths: [], maxRuntimeMs: null, ...security }
    : { sandbox, network: 'inherit', secrets: [], allowedPaths: [], maxRuntimeMs: null };
  return {
    schema: JOB_PACKAGE_SCHEMA,
    version: JOB_PACKAGE_VERSION,
    mode: 'standalone',
    runId,
    taskId,
    batchId,
    role,
    attempt: Number(attempt || 1),
    retry,
    createdAt: nowIso(),
    package: {
      dir: 'package',
      job: 'package/job.json',
      prompt: 'package/prompt.md',
      workspace: 'package/workspace.json',
      execution: 'package/execution.json',
      artifacts: 'package/artifacts.json',
      manifest: 'package/manifest.json',
      events: 'package/job_events.jsonl'
    },
    workspace: workspaceRef,
    execution: {
      backend: runner,
      agentRuntime,
      sandbox,
      cwd,
      outDir,
      skipGitRepoCheck: !!skipGitRepoCheck,
      environment: {
        inherited: true,
        variables: []
      }
    },
    prompt: {
      inline: prompt,
      file: 'package/prompt.md'
    },
    expectedArtifacts: Array.isArray(expectedArtifacts) ? expectedArtifacts : [],
    security: securityPolicy,
    artifacts: standaloneArtifactContract()
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fileRecord(outDir, name, relPath) {
  const absPath = path.join(outDir, relPath);
  try {
    const stat = fs.statSync(absPath);
    return { name, path: relPath, exists: true, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
  } catch {
    return { name, path: relPath, exists: false };
  }
}

export function buildStandaloneArtifactManifest(outDir, { runId = '', taskId = '', role = '' } = {}) {
  const contract = standaloneArtifactContract();
  return {
    schema: 'input-kanban.artifact-manifest.v1',
    version: 1,
    runId,
    taskId,
    role,
    generatedAt: nowIso(),
    root: contract.root,
    files: Object.entries(contract.files).map(([name, relPath]) => fileRecord(outDir, name, relPath))
  };
}

export function writeStandaloneArtifactManifest(outDir, metadata = {}) {
  const packageDir = path.join(outDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  const manifest = buildStandaloneArtifactManifest(outDir, metadata);
  writeJson(path.join(packageDir, 'manifest.json'), manifest);
  return manifest;
}

export function appendStandaloneJobEvent(outDir, event) {
  const packageDir = path.join(outDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  const payload = { schema: 'input-kanban.job-event.v1', at: nowIso(), ...event };
  fs.appendFileSync(path.join(packageDir, 'job_events.jsonl'), `${JSON.stringify(payload)}\n`);
  return payload;
}

export function writeStandaloneJobPackage(options) {
  const spec = createStandaloneJobSpec(options);
  const packageDir = path.join(options.outDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'prompt.md'), options.prompt || '');
  writeJson(path.join(packageDir, 'workspace.json'), spec.workspace);
  writeJson(path.join(packageDir, 'execution.json'), spec.execution);
  writeJson(path.join(packageDir, 'artifacts.json'), spec.artifacts);
  writeJson(path.join(packageDir, 'job.json'), spec);
  appendStandaloneJobEvent(options.outDir, { type: 'job.packaged', runId: spec.runId, taskId: spec.taskId, role: spec.role, backend: spec.execution.backend, agentRuntime: spec.execution.agentRuntime });
  writeStandaloneArtifactManifest(options.outDir, { runId: spec.runId, taskId: spec.taskId, role: spec.role });
  return spec;
}
