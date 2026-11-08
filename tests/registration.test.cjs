const assert = require('node:assert/strict');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { PDFToolkit } = require('../src/toolkit.js');

test('column and menus pass the installed Zotero registration validation', () => {
  const archive = process.env.ZOTERO_OMNI || '/Applications/Zotero.app/Contents/Resources/app/omni.ja';
  const read = name => execFileSync('python3', ['-c',
    'import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))',
    archive, 'chrome/content/zotero/xpcom/pluginAPI/' + name], { encoding: 'utf8' });
  const messages = [];
  const Zotero = {
    debug: () => {}, warn: message => messages.push(message), logError: error => messages.push(String(error)),
    DB: { executeTransaction: async action => action() },
    Notifier: { queue: () => {}, trigger: async () => {} }, Plugins: { addObserver: () => {} },
    Utilities: { randomString: () => String(Math.random()) },
    getMainWindows: () => [], getMainWindow: () => null
  };
  const context = vm.createContext({
    Zotero, CSS: { escape: text => text },
    require: name => { assert.equal(name, 'zotero/itemTreeColumns'); return { COLUMNS: [] }; },
    ChromeUtils: {
      defineESModuleGetters: target => { target.Zotero = Zotero; },
      importESModule: () => ({ PluginAPIBase: vm.runInContext('PluginAPIBase', context) })
    }
  });
  // Load the installed validation code; no Zotero process or library is used.
  vm.runInContext(read('pluginAPIBase.mjs').replace('export { PluginAPIBase };', ''), context);
  vm.runInContext(read('itemTreeManager.js'), context);
  vm.runInContext(read('menuManager.js'), context);
  const toolkit = new PDFToolkit({ Zotero, IOUtils: {}, PathUtils: {}, Services: {} });
  assert.doesNotThrow(() => toolkit.start('pdf-toolkit@local'), messages.join('\n'));
  assert.equal(Zotero.ItemTreeManager._columnManager.options.length, 1);
  assert.equal(Zotero.MenuManager._menuManager.options.length, 3);
  assert.equal(Zotero.MenuManager._menuManager.options[0].menus.length, 2);
});
