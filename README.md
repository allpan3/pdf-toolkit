# PDF Toolkit

A development plugin for Zotero 10.0.x. The plugin adds PDF actions to the item list and PDF reader. It does not change Zotero's default PDF reader setting.

**Status:** Version 0.2.4 is installed and enabled in Zotero 10.0.6 on macOS. All 19 offline tests pass with Zotero 10.0.8 source. The reader File menu shows Embed directly below Import Annotations. Installation and visual verification of the menu icon are pending. Live PDF conversion and database integration are not yet verified.

## Actions

| Action | Result |
| --- | --- |
| Open | Opens the attached PDF with the system default reader. |
| Embed | Writes Zotero annotations into the original attached PDF. The attachment and its path stay the same. |
| Restore | Restores the PDF and annotation data from before the last conversion, if no later edits conflict. |

The **Open PDF** column has an external-open icon. Its tooltip is **Open with system default.** Enable this column in the item list column picker. You can reduce its width until the header text is clipped. Rows without a PDF attachment have no icon. The item context menu contains **Open with system default** and **Restore before embedding…**.

In a PDF reader tab or window, select **File → Embed Annotations...**. The command is directly below **Import Annotations…** and uses the PDF in the active reader.

For a parent item, the plugin uses Zotero's preferred PDF attachment. For a PDF attachment row, it uses that attachment. The PDF must be available locally.

## Embedded annotations

Close the PDF in external readers before you select **Embed**. Zotero readers stay open. The plugin pauses their controls, waits for pending annotation saves, and reloads the PDF after the operation. The operation requires confirmation. It supports writable PDFs in editable personal libraries. It refuses symbolic links and group libraries.

The plugin uses Zotero's PDF worker to create standard PDF annotation objects. It then replaces the attached PDF at the same path. It does not create another library attachment. Highlight, underline, note, image, ink, and text annotations are covered by the offline tests.

The existing Zotero annotation records keep their keys and become external annotations. They are read-only in Zotero. Use an external PDF reader to edit them. Later external edits can cause Zotero to create new annotation records, so old links to specific annotations may change.

There is no automatic two-way annotation synchronization. You can run **Embed** again to convert new Zotero annotations. With no new Zotero annotations, the operation makes no PDF changes.

Recovery files are stored under `<Zotero data directory>/pdf-toolkit/<library ID>-<attachment key>/`. These are internal backups, not working copies. The latest recovery record is `journal.json`. PDF backups use the name `before-<file hash>.pdf` and are not deleted automatically. **Restore** refuses to overwrite later PDF or annotation edits. Close the PDF in Zotero before using Restore.

## Development

Requirements: Node.js 20 or later, Python 3, and an installed Zotero 10 application for the offline worker tests.

```sh
npm ci
npm run check
npm test
npm run build
```

The tests read `/Applications/Zotero.app/Contents/Resources/app/omni.ja`. Set `ZOTERO_OMNI` to use another installed archive. The tests use synthetic PDFs and simulated Zotero database and interface APIs. They do not start Zotero or access a personal library.

The build creates `dist/pdf-toolkit-0.2.4.xpi`. The package contains only the manifest, bootstrap code, and plugin source. Node packages are test dependencies only. The build does not install the plugin.

Local development builds can keep the same version and replace the XPI at the same path. Increase the version when you publish a release.

Updates are manual. The required `update_url` uses the reserved `.invalid` domain. No update server is configured, so Zotero cannot obtain automatic updates for this development build.

See [verification details](docs/testing.md) for coverage and remaining checks.
