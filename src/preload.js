'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organizer', {
  call: (route, body) => ipcRenderer.invoke('api', route, body),
  platform: process.platform,
  onShow: (fn) => ipcRenderer.on('show', (_e, what) => fn(what)),
  onUpdate: (fn) => ipcRenderer.on('update', (_e, state) => fn(state)),
});
