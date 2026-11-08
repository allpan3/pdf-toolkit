const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
function loadWorker() {
  const archive = process.env.ZOTERO_OMNI || '/Applications/Zotero.app/Contents/Resources/app/omni.ja';
  const read = name => execFileSync('python3', ['-c', 'import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', archive, name], { maxBuffer: 12000000 });
  const pending = new Map(); let next = 0;
  const { DOMMatrix } = require('@napi-rs/canvas');
  const context = vm.createContext({ DOMMatrix, console, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout,
    performance, DOMException, Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array,
    ArrayBuffer, DataView, structuredClone, crypto: require('node:crypto').webcrypto });
  context.self = context;
  context.postMessage = message => {
    if (message.responseID) {
      const waiter = pending.get(message.responseID);
      if (!waiter) return;
      pending.delete(message.responseID);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.data);
    } else if (message.action === 'FetchData') {
      const name = message.data;
      const prefix = /^(standard_fonts|cmaps)\//.test(name) ? 'resource/reader/pdf/web/' : 'resource/document-worker/';
      try {
        const data = new Uint8Array(read(prefix + name));
        context.onmessage({ data: { responseID: message.id, data } });
      } catch (error) { context.onmessage({ data: { responseID: message.id, error: String(error) } }); }
    } else throw new Error('Unexpected worker request: ' + message.action);
  };
  vm.runInContext(read('resource/document-worker/worker.js').toString(), context, { filename: 'zotero-document-worker.js' });
  return (action, data) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); context.onmessage({ data: { id, action, data } });
  });
}
module.exports = { loadWorker };
