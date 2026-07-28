'use strict';

/**
 * preload.js — the ONLY bridge the renderer gets. contextIsolation is on
 * and nodeIntegration is off (see main.js), so the renderer can call
 * exactly the functions listed here, nothing else in Node/Electron.
 */

const { contextBridge, ipcRenderer, clipboard } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('orchestrator', {
  listProjects: invoke('projects:list'),
  createProject: invoke('projects:create'),

  getStatus: invoke('status:get'),
  getHealth: invoke('health:get'),

  getTasks: invoke('tasks:get'),
  addTask: invoke('tasks:add'),
  removeTask: invoke('tasks:remove'),
  reorderTask: invoke('tasks:reorder'),
  approveTask: invoke('tasks:approve'),
  skipTask: invoke('tasks:skip'),

  getTimeline: invoke('timeline:get'),

  getMemory: invoke('memory:get'),
  addNote: invoke('memory:addNote'),
  resolveFailure: invoke('memory:resolveFailure'),

  getSessionHistory: invoke('sessions:history'),
  listDrivers: invoke('drivers:list'),
  getGlobalConfig: invoke('config:global'),
  getPaths: invoke('config:paths'),
  getProjectDetails: invoke('projects:details'),

  getAgents: invoke('agents:list'),
  getAgentHealth: invoke('agents:health'),

  startMission: invoke('mission:start'),
  stopMission: invoke('mission:stop'),

  // Phase 12 M3 — Operator Control Center.
  getRegistry: invoke('registry:get'),
  getServiceStatus: invoke('service:status'),
  getWorkers: invoke('service:workers'),
  isProjectLive: invoke('project:isLive'),
  getAllApprovals: invoke('approvals:all'),

  getApiToken: invoke('token:get'),
  rotateApiToken: invoke('token:rotate'),

  // Phase 10 surfaces.
  getApprovals: invoke('approvals:list'),
  decideApproval: invoke('approvals:decide'),
  getLifecycle: invoke('lifecycle:get'),
  getCoordination: invoke('coordination:get'),
  getIntelligence: invoke('intelligence:get'),
  getSchedules: invoke('schedules:get'),

  listLogFiles: invoke('logs:files'),
  getDefaultLogFile: invoke('logs:default-file'),
  pollLog: invoke('logs:poll'),
  resetLog: invoke('logs:reset'),

  pickDirectory: invoke('dialog:openDirectory'),
  pickFile: invoke('dialog:openFile'),
  openPath: invoke('shell:openPath'),
  copyText: (text) => clipboard.writeText(text),
});
