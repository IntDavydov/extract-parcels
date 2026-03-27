'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  startScraping: (url, outputPath, opts = {}) =>
    ipcRenderer.invoke('start-scraping', { url, outputPath, ...opts }),

  stopScraping: () =>
    ipcRenderer.send('stop-scraping'),

  fetchOSM: (options) =>
    ipcRenderer.invoke('fetch-osm', options),

  mergeKmz: (paths, outputPath, cleanup = true, areaNames, docName) =>
    ipcRenderer.invoke('merge-kmz', { paths, outputPath, cleanup, areaNames, docName }),

  saveDialog: (options) =>
    ipcRenderer.invoke('save-dialog', options),

  openFolderDialog: () =>
    ipcRenderer.invoke('open-folder-dialog'),

  openKmlDialog: () =>
    ipcRenderer.invoke('open-kml-dialog'),

  readKmlBbox: (filePath) =>
    ipcRenderer.invoke('read-kml-bbox', filePath),

  findProxy: (opts = {}) =>
    ipcRenderer.invoke('find-proxy', opts),

  showInFolder: (filePath) =>
    ipcRenderer.invoke('show-in-folder', filePath),

  copyIcons: (outputFolder) =>
    ipcRenderer.invoke('copy-icons', outputFolder),

  resolveBbox: (territory) =>
    ipcRenderer.invoke('resolve-bbox', territory),

  createBoundaryKmz: (geojson, outputPath) =>
    ipcRenderer.invoke('create-boundary-kmz', { geojson, outputPath }),

  resolveOutputPath: (folder, baseName) =>
    ipcRenderer.invoke('resolve-output-path', folder, baseName),

  openCsvDialog: () =>
    ipcRenderer.invoke('open-csv-dialog'),

  startElandLookup: (csvPath, outputXlsx) =>
    ipcRenderer.invoke('start-eland-lookup', { csvPath, outputXlsx }),

  stopElandLookup: () =>
    ipcRenderer.send('stop-eland-lookup'),

  generateResearchXlsx: (oblastName, outputPath) =>
    ipcRenderer.invoke('generate-research-xlsx', { oblastName, outputPath }),

  stopResearch: () =>
    ipcRenderer.send('stop-research'),

  downloadOfflineData: (options = {}) =>
    ipcRenderer.invoke('download-offline-data', options),

  onLog: (callback) =>
    ipcRenderer.on('log', (_event, msg) => callback(msg)),

  onDownloadProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('download-progress', handler);
    return () => ipcRenderer.removeListener('download-progress', handler);
  },
});
