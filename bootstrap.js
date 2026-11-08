/* global Zotero, Services */
"use strict";
var toolkit;
var generation = 0;
function install() {}
function uninstall() {}
async function startup({ id, rootURI, resourceURI }) {
  const current = ++generation;
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  if (current !== generation) return;
  const scope = { Zotero, Services, IOUtils, PathUtils };
  Services.scriptloader.loadSubScript((rootURI || resourceURI.spec) + "src/toolkit.js", scope);
  toolkit = new scope.PDFToolkit({ Zotero, Services, IOUtils, PathUtils });
  toolkit.start(id);
}
function shutdown() {
  generation++;
  toolkit?.stop();
  toolkit = undefined;
}
