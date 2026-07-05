/**
 * Tests for mission plan validation/normalization: the seam between raw
 * project JSON `tasks` and the runtime task objects the orchestrator uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isLegacyMission, normalizeAndValidateTasks, getTaskAt, getTaskById,
  getTaskIndex, taskCount, DEFAULT_TASK_MAX_RUNS,
} from '../src/mission/missionPlan.js';

function workDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-plan-'));
  fs.writeFileSync(path.join(dir, 'prompt.md'), '# task prompt');
  return dir;
}

test('a project with no tasks is legacy', () => {
  assert.equal(isLegacyMission({}), true);
  assert.equal(isLegacyMission({ tasks: [] }), true);
});

test('a project with a non-empty tasks array is not legacy', () => {
  assert.equal(isLegacyMission({ tasks: [{ id: 'T1' }] }), false);
});

test('normalizeAndValidateTasks: empty/absent tasks yields no problems', () => {
  assert.deepEqual(normalizeAndValidateTasks({}), { tasks: [], problems: [] });
  assert.deepEqual(normalizeAndValidateTasks({ tasks: [] }), { tasks: [], problems: [] });
});

test('normalizeAndValidateTasks: a valid task normalizes with defaults applied', () => {
  const dir = workDir();
  const project = { workingDirectory: dir, tasks: [{ id: 'T1', prompt: 'prompt.md' }] };
  const { tasks, problems } = normalizeAndValidateTasks(project);
  assert.deepEqual(problems, []);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'T1');
  assert.equal(tasks[0].objective, 'T1'); // defaults to id
  assert.equal(tasks[0].resolvedPromptFile, path.join(dir, 'prompt.md'));
  assert.equal(tasks[0].maxRuns, DEFAULT_TASK_MAX_RUNS);
  assert.deepEqual(tasks[0].verify, []);
  assert.equal(tasks[0].continuePrompt, null);
});

test('normalizeAndValidateTasks: explicit fields override defaults', () => {
  const dir = workDir();
  const project = {
    workingDirectory: dir,
    tasks: [{
      id: 'T1', prompt: 'prompt.md', objective: 'Do the thing',
      continuePrompt: 'keep going', maxRuns: 3,
      verify: [{ type: 'file-exists', path: 'x.txt' }],
    }],
  };
  const { tasks, problems } = normalizeAndValidateTasks(project);
  assert.deepEqual(problems, []);
  assert.equal(tasks[0].objective, 'Do the thing');
  assert.equal(tasks[0].continuePrompt, 'keep going');
  assert.equal(tasks[0].maxRuns, 3);
  assert.equal(tasks[0].verify.length, 1);
});

test('normalizeAndValidateTasks: missing id is reported', () => {
  const dir = workDir();
  const { problems } = normalizeAndValidateTasks({
    workingDirectory: dir, tasks: [{ prompt: 'prompt.md' }],
  });
  assert.ok(problems.some((p) => p.includes('id is required')));
});

test('normalizeAndValidateTasks: duplicate ids are reported', () => {
  const dir = workDir();
  const { problems } = normalizeAndValidateTasks({
    workingDirectory: dir,
    tasks: [
      { id: 'T1', prompt: 'prompt.md' },
      { id: 'T1', prompt: 'prompt.md' },
    ],
  });
  assert.ok(problems.some((p) => p.includes('not unique')));
});

test('normalizeAndValidateTasks: missing prompt file is reported with the resolved path', () => {
  const dir = workDir();
  const { problems } = normalizeAndValidateTasks({
    workingDirectory: dir, tasks: [{ id: 'T1', prompt: 'nope.md' }],
  });
  assert.ok(problems.some((p) => p.includes('nope.md')));
});

test('normalizeAndValidateTasks: unknown verifier type is reported with known types listed', () => {
  const dir = workDir();
  const { problems } = normalizeAndValidateTasks({
    workingDirectory: dir,
    tasks: [{ id: 'T1', prompt: 'prompt.md', verify: [{ type: 'telepathy' }] }],
  });
  assert.ok(problems.some((p) => p.includes('telepathy') && p.includes('Known verifier types')));
});

test('getTaskAt / getTaskById / getTaskIndex / taskCount over a normalized project', () => {
  const project = {
    tasks: [
      { id: 'T1', objective: 'first' },
      { id: 'T2', objective: 'second' },
    ],
  };
  assert.equal(taskCount(project), 2);
  assert.equal(getTaskAt(project, 0).id, 'T1');
  assert.equal(getTaskAt(project, 5), null);
  assert.equal(getTaskById(project, 'T2').objective, 'second');
  assert.equal(getTaskById(project, 'nope'), null);
  assert.equal(getTaskIndex(project, 'T2'), 1);
  assert.equal(getTaskIndex(project, 'nope'), -1);
});

test('taskCount / lookups on a legacy (no-tasks) project are safe', () => {
  assert.equal(taskCount({}), 0);
  assert.equal(getTaskAt({}, 0), null);
  assert.equal(getTaskById({}, 'T1'), null);
});
