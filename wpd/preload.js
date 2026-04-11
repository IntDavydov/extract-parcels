'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startScraping: (url, outputPath, opts = {}) => ipcRenderer.invoke('start-scraping', { url, outputPath, ...opts }),
  stopScraping: () => ipcRenderer.send('stop-scraping'),
  mergeKmz: (paths, outputPath, cleanup = true, areaNames, docName) =>
    ipcRenderer.invoke('merge-kmz', { paths, outputPath, cleanup, areaNames, docName }),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  openKmlDialog: () => ipcRenderer.invoke('open-kml-dialog'),
  openCsvDialog: () => ipcRenderer.invoke('open-csv-dialog'),
  saveDialog: (options) => ipcRenderer.invoke('save-dialog', options),
  readKmlBbox: (filePath) => ipcRenderer.invoke('read-kml-bbox', filePath),
  resolveOutputPath: (folder, baseName) => ipcRenderer.invoke('resolve-output-path', folder, baseName),
  showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
  copyIcons: (outputFolder) => ipcRenderer.invoke('copy-icons', outputFolder),
  startElandLookup: (csvPath, outputPath, options = {}) =>
    ipcRenderer.invoke('start-eland-lookup', { csvPath, outputPath, ...options }),
  stopElandLookup: () => ipcRenderer.send('stop-eland-lookup'),
  onLog: (callback) => ipcRenderer.on('log', (_event, msg) => callback(msg)),
});
