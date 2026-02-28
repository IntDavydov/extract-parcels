'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startScraping: (url, outputPath) =>
    ipcRenderer.send('start-scraping', { url, outputPath }),

  stopScraping: () =>
    ipcRenderer.send('stop-scraping'),

  fetchOSM: (options) =>
    ipcRenderer.invoke('fetch-osm', options),

  saveDialog: (options) =>
    ipcRenderer.invoke('save-dialog', options),

  openFolderDialog: () =>
    ipcRenderer.invoke('open-folder-dialog'),

  onLog: (callback) =>
    ipcRenderer.on('log', (_event, msg) => callback(msg)),

  onScrapingDone: (callback) =>
    ipcRenderer.on('scraping-done', (_event, data) => callback(data)),

  onOsmDone: (callback) =>
    ipcRenderer.on('osm-done', (_event, data) => callback(data)),
});
