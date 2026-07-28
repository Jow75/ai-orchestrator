'use strict';

/**
 * main.js — Electron entry point. Owns the single BrowserWindow and wires
 * every renderer IPC call to OrchestratorBridge/LogTail. Contains no
 * orchestrator/supervision logic itself — see orchestratorBridge.js.
 */

const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { OrchestratorBridge, ROOT_DIR } = require('./orchestratorBridge');
const { LogTail } = require('./logTail');

const bridge = new OrchestratorBridge({ rootDir: ROOT_DIR });
const logTail = new LogTail({ logsDir: path.join(ROOT_DIR, 'logs') });

/** channel -> (...args) => Promise, delegating straight to the bridge. */
const HANDLERS = {
  'projects:list': () => bridge.listProjects(),
  'projects:create': (name, definition) => bridge.createProject(name, definition),

  'status:get': () => bridge.getStatus(),
  'health:get': () => bridge.getHealth(),

  'tasks:get': (project) => bridge.getTasks(project),
  'tasks:add': (project, task) => bridge.addTask(project, task),
  'tasks:remove': (project, taskId) => bridge.removeTask(project, taskId),
  'tasks:reorder': (project, taskId, direction) => bridge.reorderTask(project, taskId, direction),
  'tasks:approve': (project, taskId) => bridge.approveTask(project, taskId),
  'tasks:skip': (project, taskId, reason) => bridge.skipTask(project, taskId, reason),

  'timeline:get': (project) => bridge.getTimeline(project),

  'memory:get': (project) => bridge.getMemory(project),
  'memory:addNote': (project, note) => bridge.addNote(project, note),
  'memory:resolveFailure': (project, id) => bridge.resolveFailure(project, id),

  'sessions:history': (project) => bridge.getSessionHistory(project),
  'drivers:list': () => bridge.listDrivers(),
  'config:global': () => bridge.getGlobalConfig(),
  'config:paths': () => bridge.getPaths(),
  'projects:details': (name) => bridge.getProjectDetails(name),

  'agents:list': (project) => bridge.getAgents(project),
  'agents:health': (project) => bridge.getAgentHealth(project),

  'mission:start': (project, options) => bridge.startMission(project, options),
  // Phase 12 M3: `project` is new and optional. Under the Core Service it is
  // required (several missions run at once, so "stop" must say which); without
  // one, the old single-orchestrator call shape still works unchanged.
  'mission:stop': (reason, project) => bridge.stopMission(reason, project),

  // Phase 12 M3 — the Operator Control Center: the whole machine at once.
  'registry:get': (options) => bridge.getRegistry(options),
  'service:status': () => bridge.getServiceStatus(),
  'service:workers': () => bridge.getWorkers(),
  'project:isLive': (project) => bridge.isProjectLive(project),
  'approvals:all': () => bridge.getAllApprovals(),

  'token:get': () => bridge.getApiToken(),
  'token:rotate': () => bridge.rotateApiToken(),

  // Phase 10 surfaces.
  'approvals:list': (project) => bridge.getApprovals(project),
  'approvals:decide': (project, id, decision, note) => bridge.decideApproval(project, id, decision, note),
  'lifecycle:get': (project) => bridge.getLifecycle(project),
  'coordination:get': (project) => bridge.getCoordination(project),
  'intelligence:get': (project) => bridge.getIntelligence(project),
  'schedules:get': () => bridge.getSchedules(),

  'logs:files': () => logTail.listFiles(),
  'logs:default-file': () => logTail.defaultFile(),
  'logs:poll': (filename) => logTail.poll(filename),
  'logs:reset': (filename) => logTail.reset(filename),
};

for (const [channel, handler] of Object.entries(HANDLERS)) {
  ipcMain.handle(channel, (event, ...args) => handler(...args));
}

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('shell:openPath', (event, targetPath) => shell.openPath(targetPath));

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'AI-Orchestrator',
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // A mission started from this app is spawned detached — closing the
  // window must never imply stopping it. Just quit the app itself.
  if (process.platform !== 'darwin') app.quit();
});
