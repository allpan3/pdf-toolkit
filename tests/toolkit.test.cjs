const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { PDFToolkit } = require('../src/toolkit.js');
const { loadWorker } = require('./worker.cjs');
const query = loadWorker();
const clone = value => JSON.parse(JSON.stringify(value));
const nativeAnnotations = () => [
  { type: 'highlight', position: { pageIndex: 0, rects: [[72,675,410,692]] } },
  { type: 'underline', position: { pageIndex: 0, rects: [[72,635,410,651]] } },
  { type: 'note', position: { pageIndex: 0, rects: [[500,675,522,697]] } },
  { type: 'image', position: { pageIndex: 0, rects: [[72,490,180,560]] } },
  { type: 'ink', position: { pageIndex: 0, width: 2, paths: [[220,490,270,535,310,500]] } },
  { type: 'text', position: { pageIndex: 0, rects: [[72,400,270,435]], fontSize: 12, rotation: 0 } }
].map((a,i) => ({ ...a, key: 'TESTKEY' + (i+1), isExternal: false, text: '', authorName: '',
  comment: a.type === 'text' ? 'Embedded text' : 'Synthetic comment ' + i,
  color: '#ffd400', pageLabel: '1', sortIndex: '00000|00000' + i + '|00000', tags: [{ name: 'test' }] }));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'pdf-toolkit-offline-'));
  const pdf = path.join(root,'attached.pdf');
  await fs.copyFile(path.join(__dirname,'fixtures/sample.pdf'),pdf);
  const state = { annotations: nativeAnnotations(), launches: [], columns: new Map(), menus: new Map(), saveFailure: false, alerts: [] };
  const attachment = { id: 2, key: 'PDFTEST1', libraryID: 1, library: { libraryType:'user', editable:true },
    isPDFAttachment:()=>true, isRegularItem:()=>false, isStoredFileAttachment:()=>false,
    getFilePathAsync:async()=>pdf, getAnnotations:()=>state.annotations, save:async()=>{},
    get attachmentModificationTime() { return fs.stat(pdf).then(s=>s.mtimeMs); } };
  const parent = { id:1, isPDFAttachment:()=>false, isRegularItem:()=>true, getAttachments:()=>[2], getBestAttachments:async()=>[attachment] };
  const records = new Map([[1,parent],[2,attachment]]);
  const IO = {
    exists:async p=>!!(await fs.stat(p).catch(()=>null)), read:p=>fs.readFile(p),
    write:(p,b)=>fs.writeFile(p,b), copy:(a,b)=>fs.copyFile(a,b), move:(a,b)=>fs.rename(a,b),
    remove:async p=>fs.rm(p,{force:true}), makeDirectory:p=>fs.mkdir(p,{recursive:true}),
    readJSON:async p=>JSON.parse(await fs.readFile(p,'utf8')),
    writeJSON:async(p,v)=>{await fs.writeFile(p+'.tmp',JSON.stringify(v));await fs.rename(p+'.tmp',p);}
  };
  const Zotero = {
    Items:{get:id=>records.get(id),getAsync:async id=>records.get(id)},
    File:{pathToFile:p=>({path:p,permissions:0o600,isSymlink:()=>false,isWritable:()=>true,launch:()=>state.launches.push(p)})},
    Reader:{_readers:[]}, Promise:{delay:ms=>new Promise(resolve=>setTimeout(resolve,ms))}, DataDirectory:{dir:root},
    Utilities:{Internal:{md5Async:async p=>crypto.createHash('md5').update(await fs.readFile(p)).digest('hex')}},
    Annotations:{toJSONSync:clone,saveFromJSON:async(a,json)=>{
      if(state.saveFailure){state.saveFailure=false;throw new Error('Injected database failure');}
      state.annotations=state.annotations.map(item=>item.key===json.key?clone(json):item);
    }},
    DB:{waitForTransaction:async()=>{},executeTransaction:async fn=>{const before=clone(state.annotations);try{return await fn();}catch(e){state.annotations=before;throw e;}}},
    PDFWorker:{_enqueue:fn=>fn(),_query:query,export:async(id,destination)=>{
      const buf=new Uint8Array(await fs.readFile(pdf)).buffer;
      const annotations=state.annotations.filter(a=>!a.isExternal).map(a=>({...a,id:a.key,dateModified:'2026-10-11T00:00:00Z',tags:a.tags.map(t=>t.name)}));
      const output=await query('pdf.writeAnnotations',{buf,annotations});
      await fs.writeFile(destination,new Uint8Array(output.buf));
    }},
    ItemTreeManager:{registerColumn:c=>{state.columns.set('column',c);return 'column';},unregisterColumn:k=>state.columns.delete(k)},
    MenuManager:{registerMenu:m=>{state.menus.set(m.menuID,m);return m.menuID;},unregisterMenu:k=>state.menus.delete(k)},
    Sync:{Storage:{Local:{SYNC_STATE_TO_UPLOAD:0}}}, logError:()=>{},
    Prefs:new Proxy({}, {get(){throw new Error('Reader preference must not be accessed');}})
  };
  const toolkit=new PDFToolkit({Zotero,IOUtils:IO,PathUtils:{join:path.join},Services:{prompt:{confirm:()=>true,alert:(...a)=>state.alerts.push(a)}}});
  toolkit.start('pdf-toolkit@local');
  return {root,pdf,state,attachment,parent,IO,Zotero,toolkit};
}

function docStub(){
  const element=()=>({style:{},children:[],listeners:{},setAttribute(){},append(c){this.children.push(c);},addEventListener(k,v){this.listeners[k]=v;}});
  return {defaultView:{},createElement:element,createElementNS:element};
}
function click(detail=1){return {button:0,detail,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};}

test('system open resolves parent and attachment without changing the reader preference',async()=>{
  const a=await setup();await a.toolkit.open(1);await a.toolkit.open(2);
  assert.deepEqual(a.state.launches,[a.pdf,a.pdf]);
  await fs.rm(a.pdf);await assert.rejects(a.toolkit.open(1),/not available/);
  assert.equal(a.state.launches.length,2);
});

test('column actions do not invoke the row action and do not repeat on a double-click',async()=>{
  const a=await setup();const column=a.state.columns.get('column');const doc=docStub();
  const cell=column.renderCell(0,'1',column,false,doc);
  assert.equal(cell.children.length,1);
  assert.equal(column.label,'Open PDF');
  assert.equal(cell.children[0].title,'Open with system default.');
  const calls=[];a.toolkit.run=async(...args)=>calls.push(args);
  const button=cell.children[0];const event=click();await button.listeners.click(event);await button.listeners.click(click(2));
  assert.equal(calls.length,1);assert.equal(event.stopped,true);assert.equal(event.prevented,true);
  const down=click();button.listeners.mousedown(down);assert.equal(down.stopped,true);
  a.toolkit.stop();assert.equal(a.state.columns.size,0);assert.equal(a.state.menus.size,0);
});

test('real Zotero worker embeds all six types in the same file, preserves keys, and rescans without duplicates',async()=>{
  const a=await setup();const before=await fs.readFile(a.pdf);const keys=a.state.annotations.map(x=>x.key);
  const result=await a.toolkit.embed(1);assert.equal(result.count,6);assert.equal(result.path,a.pdf);
  assert.notDeepEqual(await fs.readFile(a.pdf),before);
  assert.deepEqual(a.state.annotations.map(x=>x.key),keys);assert.ok(a.state.annotations.every(x=>x.isExternal));
  const check=await a.toolkit.readAnnotations(a.pdf,a.state.annotations.map(a=>({id:a.key,type:a.type,position:a.position,comment:a.comment})));
  assert.equal(check.imported.length,0);assert.equal(check.deleted.length,0);
  const encoded=await fs.readFile(a.pdf);assert.equal((await a.toolkit.embed(1)).count,0);assert.deepEqual(await fs.readFile(a.pdf),encoded);
  const output=path.join(__dirname,'..','.test-output');await fs.mkdir(output,{recursive:true});
  await fs.copyFile(a.pdf,path.join(output,'embedded.pdf'));
  await a.toolkit.restore(1);assert.deepEqual(await fs.readFile(a.pdf),before);assert.ok(a.state.annotations.every(x=>!x.isExternal));
});

test('adding a new Zotero annotation preserves previously embedded annotations',async()=>{
  const a=await setup();await a.toolkit.embed(1);
  a.state.annotations.push({...clone(nativeAnnotations()[0]),key:'NEWKEY01',position:{pageIndex:0,rects:[[72,350,300,365]]}});
  assert.equal((await a.toolkit.embed(1)).count,1);
  const check=await a.toolkit.readAnnotations(a.pdf);assert.equal(check.imported.length,7);
});

test('database failure after PDF replacement restores the file and annotation state',async()=>{
  const a=await setup();const before=await fs.readFile(a.pdf);const annotations=clone(a.state.annotations);
  a.state.saveFailure=true;await assert.rejects(a.toolkit.embed(1),/Injected database failure/);
  assert.deepEqual(await fs.readFile(a.pdf),before);assert.deepEqual(a.state.annotations,annotations);
  const journal=await a.IO.readJSON(a.toolkit.recoveryPaths(a.attachment).journal);assert.equal(journal.state,'restored');
});

test('restore refuses to overwrite PDF edits or annotation edits made later',async()=>{
  const a=await setup();await a.toolkit.embed(1);await fs.appendFile(a.pdf,'\n% external edit\n');
  const edited=await fs.readFile(a.pdf);await assert.rejects(a.toolkit.restore(1),/changed after embedding/);assert.deepEqual(await fs.readFile(a.pdf),edited);
  const b=await setup();await b.toolkit.embed(1);b.state.annotations[0].comment='New external comment';
  await assert.rejects(b.toolkit.restore(1),/changed after embedding/);
});

test('unsupported readers and group libraries block file conversion',async()=>{
  const a=await setup();a.Zotero.Reader._readers.push({itemID:2});await assert.rejects(a.toolkit.embed(1),/cannot safely pause/);
  a.Zotero.Reader._readers=[];a.attachment.library.libraryType='group';await assert.rejects(a.toolkit.embed(1),/personal library/);
});

test('PDF changes during preparation are not overwritten',async()=>{
  const a=await setup();const originalExport=a.Zotero.PDFWorker.export;
  a.Zotero.PDFWorker.export=async(...args)=>{await originalExport(...args);await fs.appendFile(a.pdf,'\n% concurrent change\n');};
  await assert.rejects(a.toolkit.embed(1),/changed during preparation/);
  assert.ok((await fs.readFile(a.pdf,'utf8')).endsWith('% concurrent change\n'));
  assert.ok(a.state.annotations.every(x=>!x.isExternal));
});

test('an unfinished journal blocks embedding even when all annotations are external',async()=>{
  const a=await setup();await a.toolkit.embed(1);
  const recovery=a.toolkit.recoveryPaths(a.attachment);
  const journal=await a.IO.readJSON(recovery.journal);journal.state='prepared';
  await a.IO.writeJSON(recovery.journal,journal);
  await assert.rejects(a.toolkit.embed(1),/unfinished operation/);
  await a.toolkit.restore(1);
  assert.ok(a.state.annotations.every(x=>!x.isExternal));
});

test('a failed later preparation preserves the preceding recovery backup',async()=>{
  const a=await setup();const first=await a.toolkit.embed(1);
  const backup=await fs.readFile(first.backup);
  const recovery=a.toolkit.recoveryPaths(a.attachment);
  const journal=await fs.readFile(recovery.journal);
  a.state.annotations.push({...clone(nativeAnnotations()[0]),key:'NEWKEY01',position:{pageIndex:0,rects:[[72,350,300,365]]}});
  a.IO.writeJSON=async()=>{throw new Error('Injected journal failure');};
  await assert.rejects(a.toolkit.embed(1),/Injected journal failure/);
  assert.deepEqual(await fs.readFile(first.backup),backup);
  assert.deepEqual(await fs.readFile(recovery.journal),journal);
});

function addReader(a, pending = false) {
  const events = [];
  const manager = { _unsavedAnnotations: new Map(pending ? [['pending',{}]] : []), _savingInProgress: false };
  const internal = { _state: { freeze: false }, _annotationManager: manager,
    freeze() { events.push('freeze'); this._state.freeze = true; },
    unfreeze() { events.push('unfreeze'); this._state.freeze = false; }
  };
  const reader = { itemID: 2, _internalReader: internal, _initPromise: Promise.resolve(),
    setAnnotations: async items => { events.push('annotations'); assert.equal(items,a.state.annotations); },
    reload: async () => events.push('reload')
  };
  a.Zotero.Reader._readers.push(reader);
  return { reader, internal, manager, events };
}

test('reader embedding waits for pending saves, refreshes all views, and resumes editing', async () => {
  const a=await setup(); const one=addReader(a,true); const two=addReader(a);
  a.Zotero.Promise.delay=async()=>{
    assert.ok(one.internal._state.freeze); assert.ok(two.internal._state.freeze);
    a.state.annotations[0].comment='Saved before embedding';
    one.manager._unsavedAnnotations.clear();
  };
  const result=await a.toolkit.embed(2);
  assert.equal(result.count,6); assert.equal(a.state.annotations[0].comment,'Saved before embedding');
  for(const r of [one,two]) assert.deepEqual(r.events,['freeze','annotations','reload','unfreeze']);
  assert.ok(a.state.annotations.every(x=>x.isExternal));
});

test('cancel leaves the reader and PDF unchanged', async () => {
  const a=await setup(); const r=addReader(a); const before=await fs.readFile(a.pdf);
  a.toolkit.Services.prompt.confirm=()=>false;
  await a.toolkit.run('embed',2,docStub());
  assert.deepEqual(r.events,[]); assert.deepEqual(await fs.readFile(a.pdf),before);
});

test('conversion failure restores the PDF and resumes its readers', async () => {
  const a=await setup(); const r=addReader(a); const before=await fs.readFile(a.pdf);
  a.state.saveFailure=true;
  await assert.rejects(a.toolkit.embed(2),/Injected database failure/);
  assert.deepEqual(await fs.readFile(a.pdf),before);
  assert.deepEqual(r.events,['freeze','annotations','reload','unfreeze']);
  assert.ok(a.state.annotations.every(x=>!x.isExternal));
});

test('read-only, busy, and newly opened readers prevent conversion', async () => {
  const a=await setup(); const r=addReader(a); const before=await fs.readFile(a.pdf);
  r.manager._readOnly=true;
  await assert.rejects(a.toolkit.embed(2),/read-only/);
  assert.deepEqual(r.events,['freeze','unfreeze']);
  r.manager._readOnly=false; r.internal._state.freeze=true; r.events.length=0;
  await assert.rejects(a.toolkit.embed(2),/reader is busy/); assert.deepEqual(r.events,[]);
  r.internal._state.freeze=false;
  const originalExport=a.Zotero.PDFWorker.export;
  a.Zotero.PDFWorker.export=async(...args)=>{await originalExport(...args);addReader(a);};
  await assert.rejects(a.toolkit.embed(2),/Close this PDF/);
  assert.deepEqual(await fs.readFile(a.pdf),before);
});

test('reader reload failure resumes the reader and reports the completed operation', async () => {
  const a=await setup(); const r=addReader(a);
  r.reader.reload=async()=>{throw new Error('Injected reload failure');};
  await assert.rejects(a.toolkit.embed(2),/operation finished.*reopen/);
  assert.equal(r.internal._state.freeze,false); assert.ok(a.state.annotations.every(x=>x.isExternal));
});

test('Embed is limited to PDF reader menus and uses the active attachment', async () => {
  const a=await setup(); const calls=[]; a.toolkit.run=async(...args)=>calls.push(args);
  assert.equal(a.state.menus.get('pdfToolkit').menus.length,2);
  for(const id of ['pdfToolkitEmbedMain','pdfToolkitEmbedWindow']) {
    const definition=a.state.menus.get(id); const menu=definition.menus[0];
    assert.deepEqual(menu.enableForTabTypes,['reader/pdf']);
    let enabled; const context={items:[a.attachment],tabType:'reader',tabSubType:'pdf',
      menuElem:{setAttribute(){}},setEnabled:value=>enabled=value};
    menu.onShowing({},context); assert.equal(enabled,true);
    await menu.onCommand({target:{ownerDocument:docStub()}},context);
    assert.equal(calls.at(-1)[0],'embed'); assert.equal(calls.at(-1)[1],2);
    const count=calls.length; context.tabSubType='epub';
    menu.onShowing({},context); assert.equal(enabled,false);
    await menu.onCommand({},context); assert.equal(calls.length,count);
    context.tabType='library';context.tabSubType='pdf';
    menu.onShowing({},context);assert.equal(enabled,false);
  }
});
