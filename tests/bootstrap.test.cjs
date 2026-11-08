const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/toolkit.js'), 'utf8');

test('the constructor is exported to the subscript target when globalThis differs', () => {
  const target = { globalThis: {} };
  vm.runInNewContext(source, target);
  assert.equal(typeof target.PDFToolkit, 'function');
});

test('bootstrap registers and removes the column and menu through the subscript target', async () => {
  const columns = new Map();
  const menus = new Map();
  const Zotero = {
    initializationPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    ItemTreeManager: {
      registerColumn: column => { columns.set('column', column); return 'column'; },
      unregisterColumn: key => columns.delete(key)
    },
    MenuManager: {
      registerMenu: menu => { menus.set(menu.menuID, menu); return menu.menuID; },
      unregisterMenu: key => menus.delete(key)
    }
  };
  const context = { Zotero, IOUtils: {}, PathUtils: {}, Services: {} };
  context.Services.scriptloader = {
    loadSubScript(uri, target) {
      assert.equal(uri, 'resource://pdf-toolkit/src/toolkit.js');
      // A subscript target need not be the sandbox global object.
      target.globalThis = context;
      vm.runInNewContext(source, target);
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'bootstrap.js'), 'utf8'), context);
  await context.startup({ id: 'pdf-toolkit@local', rootURI: 'resource://pdf-toolkit/' });
  assert.equal(columns.size, 1);
  assert.equal(menus.size, 3);
  assert.equal(columns.get('column').pluginID, 'pdf-toolkit@local');
  context.shutdown();
  assert.equal(columns.size, 0);
  assert.equal(menus.size, 0);
});
