# Verification

## Offline coverage

The build checks Zotero's required manifest fields: `applications.zotero.id`, `update_url`, and `strict_max_version`. It also checks that the manifest and package versions match.

The test suite loads the installed Zotero PDF worker in a Node VM. It uses real temporary files and simulated Zotero item, database, menu, and column APIs.

The tests cover:

- Constructor export and bootstrap registration when the subscript target differs from the global object.
- Column and menu definitions checked with the installed Zotero registration code.
- System reader opening for parent items and PDF attachment rows, without reader preference access.
- Button event handling, double-click handling, and interface registration cleanup.
- Six standard annotation types in the same attached file, with retained Zotero keys.
- A worker rescan with no duplicate or deleted annotations.
- Repeated conversion and later addition of Zotero annotations.
- Exact PDF restoration and annotation state restoration.
- An injected database failure after PDF replacement.
- Rejection of later file or metadata changes during restore.
- Rejection of unsupported, busy, read-only, and newly opened readers, and group library conversion.
- Pending save completion, reader refresh, cancellation, and reader recovery after errors.
- Reader menu selection from the active PDF attachment.
- Rejection of concurrent file changes during preparation.
- Recovery from an unfinished operation when all annotations are already external.
- Preservation of an earlier backup when a later journal write fails.

The synthetic output is `.test-output/embedded.pdf`. Independent PDF parsing confirmed standard `/Highlight`, `/Underline`, `/Text`, `/Square`, `/Ink`, and `/FreeText` annotations. The source hyperlink remained in the PDF. Visual inspection confirmed the six annotation types on the test page.

## Integration limits

The plugin targets Zotero 10.0.x. Reader source inspection used Zotero 10.0.6. Offline tests also pass with Zotero 10.0.8. The implementation uses public column and menu registration APIs, plus internal PDF worker and reader APIs. Later Zotero versions can change these internal APIs.

Version 0.2.4 passes 19 offline tests. The Plugins Manager shows version 0.2.4 enabled. The running PDF reader File menu shows **Import Annotations…**, **Embed Annotations...**, and **Save As…** in that order. Installation and visual verification of the menu icon are pending. The actual icon click and minimum column width remain unverified in the running application. Embed was not run on personal PDFs.

The following checks remain unverified in a running Zotero application:

- Plugin disable, restart, and uninstall.
- Button actions and actual mouse and keyboard behavior.
- Launch of the configured system reader.
- Annotation database transactions, file sync state, and Zotero rescanning.
- Reader display and retained annotation links after conversion.
- Editing and saving embedded annotations in the intended external reader.

A disposable-profile test stopped before plugin assertions because Zotero rejected a reader preference in `user.js`. It provides no evidence of live plugin behavior. No automated application-launch script is included.

Use only synthetic attachments in an isolated profile for later integration checks. Do not set `extensions.zotero.fileHandler.pdf` through `user.js`.

## Implementation references

- [Zotero plugin development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero 10 developer notes](https://www.zotero.org/support/dev/zotero_10_for_developers)
- [Zotero annotation storage](https://www.zotero.org/support/kb/annotations_in_database)

Relevant paths inside `omni.ja` are `chrome/content/zotero/xpcom/pdfWorker/manager.js`, `resource/document-worker/worker.js`, `chrome/content/zotero/xpcom/annotations.js`, and `chrome/content/zotero/xpcom/pluginAPI/`.

The export call uses the priority argument. It does not enable Zotero's annotation transfer mode, which removes the existing annotation records. The plugin marks the retained records as external and compares the exported annotations before file replacement.
