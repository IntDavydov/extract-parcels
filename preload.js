'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startScraping: (url, outputPath, opts = {}) =>
    ipcRenderer.invoke('start-scraping', { url, outputPath, ...opts }),

  stopScraping: () =>
    ipcRenderer.send('stop-scraping'),

  fetchOSM: (options) =>
    ipcRenderer.invoke('fetch-osm', options),

  mergeKmz: (paths, outputPath, cleanup = true) =>
    ipcRenderer.invoke('merge-kmz', { paths, outputPath, cleanup }),

  saveDialog: (options) =>
    ipcRenderer.invoke('save-dialog', options),

  openFolderDialog: () =>
    ipcRenderer.invoke('open-folder-dialog'),

  openKmlDialog: () =>
    ipcRenderer.invoke('open-kml-dialog'),

  readKmlBbox: (filePath) =>
    ipcRenderer.invoke('read-kml-bbox', filePath),

  findProxy: () =>
    ipcRenderer.invoke('find-proxy'),

  onLog: (callback) =>
    ipcRenderer.on('log', (_event, msg) => callback(msg)),
});
