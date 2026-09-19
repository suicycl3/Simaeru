import { installDevMock } from '../src/renderer/src/devMock';
installDevMock();
const api = window.api;
const loadDownloadSettings = api.download.settings;
let savedDownload: Awaited<ReturnType<typeof loadDownloadSettings>> | undefined;
api.download.settings = async () => savedDownload ??= await loadDownloadSettings();
api.download.saveSettings = async next => savedDownload = { ...await api.download.settings(), ...next };
api.aboutInfo = async () => ({ version: 'test', userData: 'C:/fixture', notices: '# Test\n\n### Fixture license\n\nLocal fixture.' });
api.lang = new URL(location.href).searchParams.get('lang') ?? 'en';
api.on = new Proxy(api.on, { get: () => () => () => {} });
api.auth.status = async () => ['dmm', 'dlsite'].map(siteId => ({ siteId, loggedIn: false, services: {}, message: null, uncertain: false, checkedAt: Date.now() })) as any;
api.library.compilationGuess = async () => false;
api.content.verify = async () => undefined as any;
api.install.dmmPlayerStatus = async () => ({ installed: false }) as any;
api.install.dgpStatus = async () => ({ installed: false }) as any;
api.sync.history = async () => [];
api.on = new Proxy(api.on, { get: () => () => () => {} });
const original = api.library.query;
const control = { mode: '', pending: [] as Array<{ query: any; release: () => Promise<void> }>, favorites: 0 };
(window as any).__review = control;
api.library.query = async query => {
  if (control.mode === 'delay') return new Promise(resolve => {
    control.pending.push({ query, release: async () => { resolve(await original(query)); } });
  });
  return original(query);
};
const favorite = api.library.setFavorite;
api.library.setFavorite = async (...args) => { control.favorites++; return favorite(...args); };
api.markViewed = async () => undefined as any;
api.library.compilation = async () => null as any;
api.files = async () => ({ files: [{ id: 1, path: 'C:/fixture/audio.wav', sizeBytes: 100, kind: 'audio', source: 'import', missingAt: null }], downloadable: 0 }) as any;
const silentAudio = URL.createObjectURL(new Blob([Uint8Array.from(atob('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='), c => c.charCodeAt(0))], { type: 'audio/wav' }));
api.content.index = async productRef => ({
  productRef, sources: [], documents: [], subtitles: [], images: [], videos: [], books: [], lossyOnly: [], pdfStrip: [], archives: [], storage: null, wavBytes: 0, wavCount: 0, audioOnlyInArchive: false,
  audioGroups: [{ folder: '', label: '長い日本語のグループ名', tags: [], tracks: [{ url: silentAudio, relPath: 'long-track.wav', name: '長い日本語のトラック名.wav', size: 44, container: 'C:/fixture', inArchive: false }] }]
});
