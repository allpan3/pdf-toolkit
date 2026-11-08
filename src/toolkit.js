"use strict";

// Zotero's subscript loader reads this property from its target object.
var PDFToolkit = class PDFToolkit {
  constructor({ Zotero, IOUtils, PathUtils, Services }) {
    Object.assign(this, { Zotero, IO: IOUtils, Path: PathUtils, Services });
    this.enabled = false;
    this.busy = new Set();
    this.columns = [];
    this.menus = [];
  }

  hasPDF(item) {
    if (!item || item.deleted) return false;
    if (item.isPDFAttachment()) return true;
    return item.isRegularItem() && item.getAttachments().some(id => {
      const child = this.Zotero.Items.get(id);
      return child && !child.deleted && child.isPDFAttachment();
    });
  }

  async getPDF(itemID) {
    const item = await this.Zotero.Items.getAsync(itemID);
    if (!item || item.deleted) throw new Error("The item is no longer available.");
    if (item.isPDFAttachment()) return item;
    if (item.isRegularItem()) {
      const pdf = (await item.getBestAttachments()).find(a => !a.deleted && a.isPDFAttachment());
      if (pdf) return pdf;
    }
    throw new Error("This item has no PDF attachment.");
  }

  async localPath(attachment) {
    const path = await attachment.getFilePathAsync();
    if (!path || !await this.IO.exists(path)) throw new Error("The PDF is not available locally.");
    return path;
  }

  async locked(itemID, action) {
    if (!this.enabled) throw new Error("PDF Toolkit is disabled.");
    const attachment = await this.getPDF(itemID);
    if (this.busy.has(attachment.id)) throw new Error("An operation is already running for this PDF.");
    this.busy.add(attachment.id);
    try { return await action(attachment); }
    finally { this.busy.delete(attachment.id); }
  }

  async open(itemID) {
    return this.locked(itemID, async attachment => {
      const path = await this.localPath(attachment);
      if (!this.enabled) return;
      // LaunchServices uses the system association without Zotero's reader fallback.
      this.Zotero.File.pathToFile(path).launch();
    });
  }

  activeReaders(attachment) {
    return this.Zotero.Reader._readers.filter(reader =>
      reader.itemID === attachment.id && !reader._isTabClosed && !reader._isUninitialized);
  }

  async withReadersFrozen(attachment, action) {
    const frozen = new Set();
    let changed = false;
    let operationError;
    try {
      for (const reader of this.activeReaders(attachment)) {
        await reader._initPromise;
        const internal = reader._internalReader;
        const manager = internal?._annotationManager;
        if (!internal || typeof internal.freeze !== "function" || typeof internal.unfreeze !== "function"
          || !manager?._unsavedAnnotations || typeof reader.reload !== "function"
          || typeof reader.setAnnotations !== "function") {
          throw new Error("This Zotero reader cannot safely pause annotation editing.");
        }
        if (internal._state?.freeze) throw new Error("The PDF reader is busy. Try again after it finishes.");
        internal.freeze();
        frozen.add(reader);
      }
      // Let Zotero finish its normal debounced saves before taking a snapshot.
      const deadline = Date.now() + 15000;
      for (const reader of frozen) {
        const internal = reader._internalReader;
        const manager = internal._annotationManager;
        while (manager._unsavedAnnotations.size || manager._savingInProgress) {
          if (Date.now() >= deadline) throw new Error("Zotero has not finished saving annotations. Try again after saving finishes.");
          await this.Zotero.Promise.delay(50);
        }
        if (internal._state?.readOnly || manager._readOnly) {
          throw new Error("The PDF reader is read-only. Check that Zotero can save annotations.");
        }
      }
      // Annotation deletions can finish after the reader's save callback.
      await this.Zotero.DB.waitForTransaction();
      this.checkWritable(attachment, frozen);
      changed = true;
      return await action(frozen);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      let refreshError;
      for (const reader of frozen) {
        if (reader._isTabClosed || reader._isUninitialized) continue;
        try {
          if (changed) {
            await reader.setAnnotations(attachment.getAnnotations());
            await reader.reload();
          }
        } catch (error) {
          refreshError = error;
          this.Zotero.logError(error);
        } finally {
          reader._internalReader.unfreeze();
        }
      }
      if (refreshError && !operationError) {
        throw new Error("The PDF operation finished, but the reader could not reload it. Close and reopen the PDF.");
      }
    }
  }

  checkWritable(attachment, frozen = new Set()) {
    if (!this.enabled) throw new Error("PDF Toolkit is disabled.");
    if (attachment.library.libraryType !== "user" || !attachment.library.editable) {
      throw new Error("Embedding is supported only in an editable personal library.");
    }
    if (this.activeReaders(attachment).some(reader => !frozen.has(reader) || !reader._internalReader?._state?.freeze)) {
      throw new Error("Close this PDF in Zotero before changing its embedded annotations.");
    }
  }

  snapshots(attachment) {
    return attachment.getAnnotations().map(item => {
      const json = this.Zotero.Annotations.toJSONSync(item);
      return {
        key: json.key, type: json.type, isExternal: !!json.isExternal,
        authorName: json.authorName || "", text: json.text || "",
        comment: json.comment || "", color: json.color,
        pageLabel: json.pageLabel, sortIndex: json.sortIndex, position: json.position,
        tags: (json.tags || []).map(tag => ({ name: tag.name })).sort((a, b) => a.name.localeCompare(b.name))
      };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }

  same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
  hash(path) { return this.Zotero.Utilities.Internal.md5Async(path); }

  recoveryPaths(attachment) {
    const directory = this.Path.join(this.Zotero.DataDirectory.dir, "pdf-toolkit", `${attachment.libraryID}-${attachment.key}`);
    return { directory, journal: this.Path.join(directory, "journal.json") };
  }

  async writeJournal(path, journal) {
    await this.IO.writeJSON(path, journal, { tmpPath: path + ".tmp" });
  }

  async readAnnotations(path, existingAnnotations = []) {
    const worker = this.Zotero.PDFWorker;
    return worker._enqueue(async () => {
      const bytes = await this.IO.read(path);
      const buf = new Uint8Array(bytes).buffer;
      return worker._query("pdf.importAnnotations", {
        buf, existingAnnotations, transfer: false
      }, [buf]);
    }, true);
  }

  async applySnapshots(attachment, snapshots) {
    await this.Zotero.DB.executeTransaction(async () => {
      for (const json of snapshots) {
        await this.Zotero.Annotations.saveFromJSON(attachment, json, { skipDateModifiedUpdate: true });
      }
      attachment.attachmentLastProcessedModificationTime = Math.floor((await attachment.attachmentModificationTime) / 1000);
      if (attachment.isStoredFileAttachment()) {
        attachment.attachmentSyncState = this.Zotero.Sync.Storage.Local.SYNC_STATE_TO_UPLOAD;
      }
      await attachment.save({ skipDateModifiedUpdate: true });
    });
  }

  async embed(itemID) {
    return this.locked(itemID, attachment => this.withReadersFrozen(attachment, async frozen => {
      this.checkWritable(attachment, frozen);
      const path = await this.localPath(attachment);
      const file = this.Zotero.File.pathToFile(path);
      if (file.isSymlink()) throw new Error("Embedding through a symbolic link is not supported.");
      if (!file.isWritable()) throw new Error("The PDF file is not writable.");
      const before = this.snapshots(attachment);
      const pending = before.filter(annotation => !annotation.isExternal);
      const recovery = this.recoveryPaths(attachment);
      if (await this.IO.exists(recovery.journal)) {
        const previous = await this.IO.readJSON(recovery.journal);
        if (!["complete", "restored"].includes(previous.state)) {
          throw new Error("An unfinished operation needs recovery. Use Restore before embedding again.");
        }
      }
      if (!pending.length) return { count: 0, path };
      await this.IO.makeDirectory(recovery.directory, { ignoreExisting: true, permissions: 0o700 });
      const originalHash = await this.hash(path);
      // A later preparation must not overwrite an earlier recovery backup.
      const backup = this.Path.join(recovery.directory, `before-${originalHash}.pdf`);
      const stage = path + ".pdf-toolkit.tmp";
      if (await this.IO.exists(stage)) throw new Error("A temporary PDF already exists: " + stage);
      let journal;
      let replaced = false;
      let preserveStage = false;
      try {
        const currentPDF = await this.readAnnotations(path);
        if (currentPDF.imported.some(annotation => pending.some(json => json.key === annotation.id))) {
          throw new Error("This PDF already contains one of the Zotero annotations. Recover the earlier operation before embedding again.");
        }
        await this.Zotero.PDFWorker.export(attachment.id, stage, true);
        const result = await this.readAnnotations(stage);
        const byKey = new Map(result.imported.map(annotation => [annotation.id, annotation]));
        const after = before.map(json => {
          if (json.isExternal) return json;
          const embedded = byKey.get(json.key);
          if (!embedded || embedded.type !== json.type) {
            throw new Error("The exported PDF did not preserve every annotation. The attached PDF was not changed.");
          }
          return { ...json, isExternal: true, position: embedded.position, comment: embedded.comment || "", color: embedded.color };
        });
        const verification = await this.readAnnotations(stage, after.map(json => ({
          id: json.key, type: json.type, position: json.position, comment: json.comment
        })));
        if (verification.imported.length || verification.deleted.length) {
          throw new Error("Zotero would duplicate or replace annotations after this conversion. The attached PDF was not changed.");
        }
        this.checkWritable(attachment, frozen);
        if (originalHash !== await this.hash(path) || !this.same(before, this.snapshots(attachment))) {
          throw new Error("The PDF or its annotations changed during preparation. Close other editors and try again.");
        }
        if (!await this.IO.exists(backup)) await this.IO.copy(path, backup, { noOverwrite: true });
        if (originalHash !== await this.hash(backup)) throw new Error("The recovery backup could not be verified.");
        journal = {
          version: 1, state: "prepared", path, libraryID: attachment.libraryID, attachmentKey: attachment.key,
          originalHash, embeddedHash: await this.hash(stage), before, after
        };
        await this.writeJournal(recovery.journal, journal);
        // Preserve the original file mode across the atomic file replacement.
        this.Zotero.File.pathToFile(stage).permissions = file.permissions;
        this.checkWritable(attachment, frozen);
        if (originalHash !== await this.hash(path) || !this.same(before, this.snapshots(attachment))) {
          journal.state = "restored";
          await this.writeJournal(recovery.journal, journal);
          throw new Error("The PDF or annotations changed before saving. The attached PDF was not changed.");
        }
        await this.IO.move(stage, path, { noOverwrite: false });
        replaced = true;
        await this.applySnapshots(attachment, after);
        journal.state = "complete";
        await this.writeJournal(recovery.journal, journal);
        return { count: pending.length, path, backup };
      } catch (error) {
        if (replaced) {
          try {
            await this.restoreJournal(attachment, recovery, journal);
          } catch (recoveryError) {
            preserveStage = true;
            throw new Error(`${error.message}\nRecovery needs attention: ${recoveryError.message}\nBackup: ${backup}`);
          }
        }
        throw error;
      } finally {
        if (!preserveStage) await this.IO.remove(stage, { ignoreAbsent: true });
      }
    }));
  }

  async restoreJournal(attachment, recovery, journal) {
    const path = await this.localPath(attachment);
    if (journal.version !== 1 || path !== journal.path || attachment.key !== journal.attachmentKey || attachment.libraryID !== journal.libraryID) {
      throw new Error("The recovery record does not match this attachment.");
    }
    if (!/^[a-f0-9]{32}$/.test(journal.originalHash)) throw new Error("The recovery hash is not valid.");
    const backup = this.Path.join(recovery.directory, `before-${journal.originalHash}.pdf`);
    if (await this.hash(backup) !== journal.originalHash) throw new Error("The recovery backup has changed.");
    const currentHash = await this.hash(path);
    const current = this.snapshots(attachment);
    if (![journal.originalHash, journal.embeddedHash].includes(currentHash)
      || (!this.same(current, journal.before) && !this.same(current, journal.after))) {
      throw new Error("The PDF or annotations changed after embedding. Automatic restore would overwrite those changes.");
    }
    const bytes = await this.IO.read(backup);
    const temp = path + ".pdf-toolkit-restore.tmp";
    if (await this.IO.exists(temp)) throw new Error("A restore file already exists: " + temp);
    const permissions = this.Zotero.File.pathToFile(path).permissions;
    try {
      await this.IO.write(temp, bytes);
      this.Zotero.File.pathToFile(temp).permissions = permissions;
      if (currentHash !== await this.hash(path) || !this.same(current, this.snapshots(attachment))) {
        throw new Error("The PDF or annotations changed during recovery.");
      }
      await this.IO.move(temp, path, { noOverwrite: false });
      await this.applySnapshots(attachment, journal.before);
      journal.state = "restored";
      await this.writeJournal(recovery.journal, journal);
    } finally {
      await this.IO.remove(temp, { ignoreAbsent: true });
    }
  }

  async restore(itemID) {
    return this.locked(itemID, async attachment => {
      this.checkWritable(attachment);
      const recovery = this.recoveryPaths(attachment);
      if (!await this.IO.exists(recovery.journal)) throw new Error("There is no recovery backup for this attachment.");
      const journal = await this.IO.readJSON(recovery.journal);
      await this.restoreJournal(attachment, recovery, journal);
      return { path: journal.path };
    });
  }

  async run(action, itemID, doc) {
    try {
      if (action === "embed" && !this.Services.prompt.confirm(doc.defaultView, "Embed annotations in this PDF",
        "Close this PDF in other editors first.\n\nThis updates the attached PDF and keeps a recovery backup. Embedded annotations become read-only in Zotero. Edit them in your external PDF reader.\n\nContinue?")) return;
      if (action === "restore" && !this.Services.prompt.confirm(doc.defaultView, "Restore PDF and annotations",
        "Restore the PDF and Zotero annotations from before the last embedding operation?")) return;
      const result = await this[action](itemID);
      if (action !== "open") this.Services.prompt.alert(doc.defaultView, "PDF Toolkit",
        action === "embed" ? `Embedded ${result.count} annotation(s) in the attached PDF.` : "Restored the PDF and annotations.");
    } catch (error) {
      this.Zotero.logError(error);
      this.Services.prompt.alert(doc.defaultView, "PDF Toolkit", error.message || String(error));
    }
  }

  renderCell(index, data, column, isFirstColumn, doc) {
    const cell = doc.createElement("span");
    cell.className = "cell " + column.className;
    if (!data) return cell;
    const title = "Open with system default.";
    const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.style.cssText = "color: inherit; background: transparent; border: 0; padding: 2px 2px; cursor: pointer; display: inline-flex; align-items: center; vertical-align: middle;";
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({
      width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true"
    })) icon.setAttribute(name, value);
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M14 3h7v7 M21 3 10 14 M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5");
    icon.append(path);
    button.append(icon);
    for (const eventName of ["pointerdown", "mousedown", "dblclick"]) button.addEventListener(eventName, event => event.stopPropagation());
    for (const eventName of ["keydown", "keypress", "keyup"]) button.addEventListener(eventName, event => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    button.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (event.button === 0 && event.detail <= 1) return this.run("open", Number(data), doc);
    });
    cell.append(button);
    return cell;
  }

  start(pluginID) {
    this.enabled = true;
    try {
      const column = this.Zotero.ItemTreeManager.registerColumn({
        dataKey: "pdfToolkit", label: "Open PDF", pluginID, enabledTreeIDs: ["main"],
        showInColumnPicker: true, flex: 0, width: "36", minWidth: 20,
        dataProvider: item => this.hasPDF(item) ? String(item.id) : "",
        renderCell: this.renderCell.bind(this), zoteroPersist: ["width", "hidden", "ordinal"]
      });
      if (!column) throw new Error("Could not register the PDF Toolkit column.");
      this.columns.push(column);
      const menu = this.Zotero.MenuManager.registerMenu({
        menuID: "pdfToolkit", pluginID, target: "main/library/item",
        menus: [
          ["open", "PDF Toolkit: Open with system default"],
          ["restore", "PDF Toolkit: Restore before embedding…"]
        ].map(([action, label]) => ({
          menuType: "menuitem",
          onShowing: (event, context) => {
            context.menuElem.setAttribute("label", label);
            const items = context.items || [];
            context.setEnabled(items.length === 1 && this.hasPDF(items[0]));
          },
          onCommand: (event, context) => {
            const items = context.items || [];
            if (items.length === 1) return this.run(action, items[0].id, event.target.ownerDocument);
          }
        }))
      });
      if (!menu) throw new Error("Could not register the PDF Toolkit menu.");
      this.menus.push(menu);
      for (const target of ["main/menubar/file", "reader/menubar/file"]) {
        const readerMenu = this.Zotero.MenuManager.registerMenu({
          menuID: target.startsWith("main/") ? "pdfToolkitEmbedMain" : "pdfToolkitEmbedWindow", pluginID, target,
          menus: [{
            menuType: "menuitem", enableForTabTypes: ["reader/pdf"],
            icon: this.Zotero.isMac
              ? "chrome://zotero/skin/mac/menu/annotation.svg"
              : "chrome://zotero/skin/16/universal/annotation.svg",
            onShowing: (event, context) => {
              context.menuElem.setAttribute("label", "Embed Annotations...");
              const importMenu = context.menuElem.parentNode?.querySelector("#menu_transferFromPDF");
              if (importMenu) importMenu.after(context.menuElem);
              const item = context.items?.[0];
              context.setEnabled(context.tabType === "reader" && context.tabSubType === "pdf"
                && context.items.length === 1 && item?.isPDFAttachment()
                && !item.deleted && item.library.libraryType === "user" && item.library.editable
                && !this.busy.has(item.id));
            },
            onCommand: (event, context) => {
              const item = context.items?.[0];
              if (context.tabType === "reader" && context.tabSubType === "pdf"
                && context.items.length === 1 && item?.isPDFAttachment()) {
                return this.run("embed", item.id, event.target.ownerDocument);
              }
            }
          }]
        });
        if (!readerMenu) throw new Error("Could not register the PDF reader menu.");
        this.menus.push(readerMenu);
      }
    } catch (error) { this.stop(); throw error; }
  }

  stop() {
    this.enabled = false;
    for (const key of this.columns) this.Zotero.ItemTreeManager.unregisterColumn(key);
    for (const key of this.menus) this.Zotero.MenuManager.unregisterMenu(key);
    this.columns = []; this.menus = [];
  }
};

if (typeof module !== "undefined") module.exports = { PDFToolkit };
