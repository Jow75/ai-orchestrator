/**
 * mockDriver.js — Scriptable in-process driver for tests and dry runs.
 *
 * Lets the orchestrator be exercised end-to-end without a real AI engine:
 * each launch plays the next entry of a scripted sequence (defined in the
 * project's `mock.runs` config), emitting output and exiting exactly as a
 * real engine would.
 *
 * Also useful for operators: `"driver": "mock"` in a project config gives a
 * safe way to verify the whole supervision pipeline (status.json, logs,
 * notifications, resume flow) before pointing it at a real mission.
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AIDriver, AgentRun } from './aiDriver.js';

/** Default script: one run that immediately completes the mission. */
const DEFAULT_RUNS = [
  {
    output: 'mock agent did some work\nMISSION COMPLETE\n',
    result: 'MISSION COMPLETE',
    exitCode: 0,
    delayMs: 50,
  },
];

export class MockDriver extends AIDriver {
  constructor({ logger }) {
    super({ logger });
    this.id = 'mock';
    this.name = 'Mock Engine';
    // This driver writes nothing but what a fixture tells it to. Every surface
    // that reports a mock mission must disclose that — see simulation.js.
    this.simulated = true;
    this.launchCount = 0;
    // Test introspection: every prompt this driver was launched with, in
    // order — lets orchestrator-level tests assert on real briefing content
    // (see Phase P4's Continuation Builder) without parsing log output.
    this.receivedPrompts = [];

    this.exitPatterns = {
      usageLimit: [/usage limit reached/i],
      network: [/network failure/i],
    };
  }

  /** @inheritdoc */
  async checkInstallation() {
    return { ok: true, version: 'mock-1.0.0' };
  }

  /** @inheritdoc */
  async launch({ project, prompt, engineSessionId }) {
    this.receivedPrompts.push(prompt);
    const runs = project.mock?.runs?.length ? project.mock.runs : DEFAULT_RUNS;
    // Replay the last scripted entry if launches outnumber script entries.
    const script = runs[Math.min(this.launchCount, runs.length - 1)];
    this.launchCount += 1;

    const run = new MockRun({
      script,
      engineSessionId,
      launchIndex: this.launchCount,
      workingDirectory: project.workingDirectory,
    });
    run.begin();
    return run;
  }

  /** @inheritdoc */
  extractLimitResetTime(outputTail) {
    // Mock format: "usage limit reached|<epoch-ms>"
    const match = outputTail.match(/usage limit reached\|(\d+)/i);
    return match ? new Date(Number(match[1])) : null;
  }
}

class MockRun extends AgentRun {
  constructor({ script, engineSessionId, launchIndex, workingDirectory }) {
    super();
    this.script = script;
    this.engineSessionId = engineSessionId;
    this.launchIndex = launchIndex;
    this.workingDirectory = workingDirectory;
    this.pid = 100_000 + launchIndex; // fake but unique
    this.stopped = false;
  }

  begin() {
    const {
      output = '',
      result = null,
      exitCode = 0,
      signal = null,
      delayMs = 10,
      // Optional: simulate an agent that actually changes the workspace, so
      // the progress engine can be exercised end-to-end. `writeFile` uses a
      // fixed name (overwrites); `appendFile` grows a file each run.
      writeFile = null,
      appendFile = null,
    } = this.script;

    // Emit asynchronously so callers can attach listeners first.
    setTimeout(() => {
      this.applyWorkspaceEffect(writeFile, appendFile);
      // Mock keeps the session id stable across resumes for simplicity.
      this.emit('engine-session-id', this.engineSessionId ?? `mock-session-${this.pid}`);
      if (output) this.emit('output', output);
      this.emit('activity', 'mock work in progress');
      if (result !== null) this.emit('result', { text: result, isError: exitCode !== 0 });

      if (!this.stopped) {
        this.finish({
          code: exitCode,
          signal,
          outputTail: output,
          resultText: result,
          resultIsError: exitCode !== 0,
        });
      }
    }, delayMs);
  }

  /** Simulate the agent changing the workspace (drives the progress engine). */
  applyWorkspaceEffect(writeFile, appendFile) {
    if (!this.workingDirectory) return;
    try {
      // Real agents create parent directories automatically when writing a
      // nested path (e.g. Claude Code's Write tool) — mirror that here so
      // scripted `writeFile: { path: "src/index.js" }` behaves realistically
      // rather than silently failing when "src/" doesn't exist yet.
      if (writeFile) {
        const target = join(this.workingDirectory, writeFile.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, writeFile.content ?? '');
      }
      if (appendFile) {
        const target = join(this.workingDirectory, appendFile.path);
        mkdirSync(dirname(target), { recursive: true });
        appendFileSync(target, appendFile.content ?? `run ${this.launchIndex}\n`);
      }
    } catch {
      // A missing working directory in a test is not the mock's concern.
    }
  }

  /** @inheritdoc */
  async requestStop() {
    this.stopped = true;
    this.finish({
      code: null,
      signal: 'SIGTERM',
      outputTail: '',
      resultText: null,
      resultIsError: false,
    });
  }
}

export default MockDriver;
