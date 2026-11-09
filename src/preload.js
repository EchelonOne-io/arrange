'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organizer', {
  call: (route, body) => ipcRenderer.invoke('api', route, body),
  platform: process.platform,
});
