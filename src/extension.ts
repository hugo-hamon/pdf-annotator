import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { Annotation, clean, loadPdf, toMarkdown, writeAnnotations } from './pdfAnnotations';

class PdfDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    /** Original file bytes on disk. */
    public bytes: Uint8Array,
    /** PDF without managed annotations, displayed by pdf.js. */
    public display: Uint8Array,
    public annotations: Annotation[],
    public encrypted: boolean,
  ) {}
  dispose(): void {}
}

/** Sidecar fallback when annotations cannot be written to the PDF (e.g. encrypted files). */
const sidecarUri = (uri: vscode.Uri) => uri.with({ path: uri.path + '.annotations.json' });
const baseName = (uri: vscode.Uri) => uri.path.split('/').pop() ?? 'document.pdf';

class PdfAnnotatorProvider implements vscode.CustomEditorProvider<PdfDocument> {
  static readonly viewType = 'pdfAnnotator.editor';

  private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
  readonly onDidChangeCustomDocument = this._onDidChange.event;

  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
  private readonly diagnostic = vscode.window.createOutputChannel('PDF Annotator');
  private readonly openedAt = new Map<string, number>();
  private lastEdit?: { doc: PdfDocument; key: string; rec: { before: Annotation[]; after: Annotation[] }; time: number };
  /** Active editor document, used by the command palette action. */
  active?: PdfDocument;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // ------------------------------------------------------------ lifecycle

  async openCustomDocument(uri: vscode.Uri, ctx: vscode.CustomDocumentOpenContext): Promise<PdfDocument> {
    const started = performance.now();
    this.openedAt.set(uri.toString(), started);
    const source = ctx.backupId ? vscode.Uri.parse(ctx.backupId) : uri;
    const bytes = await vscode.workspace.fs.readFile(source);
    this.diagnostic.appendLine(`PDF ${baseName(uri)}: file read in ${Math.round(performance.now() - started)} ms (${bytes.byteLength} bytes)`);
    const doc = await this.build(uri, bytes);
    this.diagnostic.appendLine(`PDF ${baseName(uri)}: annotations parsed in ${Math.round(performance.now() - started)} ms total`);
    return doc;
  }

  private async build(uri: vscode.Uri, bytes: Uint8Array): Promise<PdfDocument> {
    const { annotations, display, encrypted } = await loadPdf(bytes);
    let merged = annotations;
    try {
      const raw = await vscode.workspace.fs.readFile(sidecarUri(uri));
      const extra = (JSON.parse(Buffer.from(raw).toString('utf8')) as unknown[]).map(clean).filter(Boolean) as Annotation[];
      const ids = new Set(annotations.map((a) => a.id));
      merged = [...annotations, ...extra.filter((a) => !ids.has(a.id))];
    } catch {
      /* no sidecar file */
    }
    return new PdfDocument(uri, bytes, display, merged, encrypted);
  }

  async resolveCustomEditor(doc: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };

    const key = doc.uri.toString();
    if (!this.panels.has(key)) this.panels.set(key, new Set());
    this.panels.get(key)!.add(panel);
    this.active = doc;

    panel.webview.onDidReceiveMessage((msg) => this.onMessage(doc, panel, msg));
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.active = doc;
    });
    panel.onDidDispose(() => {
      this.panels.get(key)?.delete(panel);
      if (this.active === doc && !this.panels.get(key)?.size) this.active = undefined;
    });
    panel.webview.html = this.html(panel.webview, media);
    this.diagnostic.appendLine(`PDF ${baseName(doc.uri)}: editor panel created after ${Math.round(performance.now() - (this.openedAt.get(key) ?? performance.now()))} ms`);
  }

  // ------------------------------------------------------------- messages

  private onMessage(doc: PdfDocument, panel: vscode.WebviewPanel, msg: any): void {
    switch (msg?.type) {
      case 'ready':
        this.diagnostic.appendLine(`PDF ${baseName(doc.uri)}: webview ready after ${Math.round(performance.now() - (this.openedAt.get(doc.uri.toString()) ?? performance.now()))} ms`);
        void panel.webview.postMessage(this.loadMessage(doc));
        if (doc.encrypted) {
          void vscode.window.showWarningMessage(
            'Encrypted PDF: annotations will be saved to an .annotations.json file next to the PDF.',
          );
        }
        break;
      case 'performance':
        if (typeof msg.phase === 'string' && typeof msg.elapsed === 'number') {
          this.diagnostic.appendLine(`PDF ${baseName(doc.uri)}: ${msg.phase} after ${Math.round(msg.elapsed)} ms (webview)`);
        }
        break;
      case 'add': {
        const a = clean(msg.annotation);
        if (a && !doc.annotations.some((x) => x.id === a.id)) {
          this.change(doc, 'Add annotation', (l) => [...l, a]);
        }
        break;
      }
      case 'update': {
        const patch: Partial<Annotation> = {};
        if (typeof msg.patch?.comment === 'string') patch.comment = msg.patch.comment;
        if (typeof msg.patch?.color === 'string' && /^#[0-9a-f]{6}$/i.test(msg.patch.color)) patch.color = msg.patch.color;
        const isComment = 'comment' in patch;
        this.change(
          doc,
          isComment ? 'Edit comment' : 'Change color',
          (l) => l.map((a) => (a.id === msg.id ? { ...a, ...patch } : a)),
          // Consecutive comment edits share one undo step.
          isComment ? { key: `comment:${msg.id}`, skip: panel } : {},
        );
        break;
      }
      case 'remove':
        this.change(doc, 'Remove annotation', (l) => l.filter((a) => a.id !== msg.id));
        break;
      case 'quotes':
        // Extract quoted text from external annotations without adding an undo step.
        for (const u of Array.isArray(msg.updates) ? msg.updates : []) {
          const a = doc.annotations.find((x) => x.id === u.id);
          if (a && !a.text && typeof u.text === 'string') a.text = u.text;
        }
        break;
      case 'export':
        void this.exportNotes(doc);
        break;
    }
  }

  private change(
    doc: PdfDocument,
    label: string,
    fn: (list: Annotation[]) => Annotation[],
    opts: { key?: string; skip?: vscode.WebviewPanel } = {},
  ): void {
    const now = Date.now();
    const last = this.lastEdit;
    if (opts.key && last && last.doc === doc && last.key === opts.key && now - last.time < 4000) {
      last.rec.after = fn(last.rec.after);
      last.time = now;
      doc.annotations = last.rec.after;
      this.broadcast(doc, opts.skip);
      return;
    }
    const rec = { before: doc.annotations, after: fn(doc.annotations) };
    doc.annotations = rec.after;
    this.lastEdit = opts.key ? { doc, key: opts.key, rec, time: now } : undefined;
    this._onDidChange.fire({
      document: doc,
      label,
      // VS Code invokes these callbacks for undo and redo.
      undo: () => {
        doc.annotations = rec.before;
        this.lastEdit = undefined;
        this.broadcast(doc);
      },
      redo: () => {
        doc.annotations = rec.after;
        this.lastEdit = undefined;
        this.broadcast(doc);
      },
    });
    this.broadcast(doc, opts.skip);
  }

  private broadcast(doc: PdfDocument, skip?: vscode.WebviewPanel): void {
    for (const p of this.panels.get(doc.uri.toString()) ?? []) {
      if (p !== skip) void p.webview.postMessage({ type: 'annotations', annotations: doc.annotations });
    }
  }

  private loadMessage(doc: PdfDocument) {
    const { buffer, byteOffset, byteLength } = doc.display;
    return {
      type: 'load',
      // Base64 avoids differences in VS Code's typed-array serialization.
      // The copy prevents pdf.js from detaching the original buffer.
      data: Buffer.from(buffer, byteOffset, byteLength).toString('base64'),
      annotations: doc.annotations,
    };
  }

  // ------------------------------------------------------ save and backup

  async saveCustomDocument(doc: PdfDocument): Promise<void> {
    await this.write(doc, doc.uri);
  }

  async saveCustomDocumentAs(doc: PdfDocument, destination: vscode.Uri): Promise<void> {
    await this.write(doc, destination);
  }

  private async write(doc: PdfDocument, target: vscode.Uri): Promise<void> {
    try {
      if (doc.encrypted) throw new Error('Encrypted PDF');
      const out = await writeAnnotations(doc.bytes, doc.annotations);
      await vscode.workspace.fs.writeFile(target, out);
      if (target.toString() === doc.uri.toString()) {
        doc.bytes = out;
        try {
          await vscode.workspace.fs.delete(sidecarUri(target));
        } catch {
          /* no sidecar file */
        }
      }
    } catch (err) {
      // Preserve annotations in a sidecar JSON file if the PDF cannot be modified.
      const side = sidecarUri(target);
      await vscode.workspace.fs.writeFile(side, Buffer.from(JSON.stringify(doc.annotations, null, 2), 'utf8'));
      void vscode.window.showWarningMessage(
        `Could not write annotations to the PDF (${(err as Error).message}). ` +
          `They were saved to ${baseName(side)}.`,
      );
    }
  }

  async revertCustomDocument(doc: PdfDocument): Promise<void> {
    const fresh = await this.build(doc.uri, await vscode.workspace.fs.readFile(doc.uri));
    Object.assign(doc, { bytes: fresh.bytes, display: fresh.display, annotations: fresh.annotations, encrypted: fresh.encrypted });
    this.lastEdit = undefined;
    for (const p of this.panels.get(doc.uri.toString()) ?? []) void p.webview.postMessage(this.loadMessage(doc));
  }

  async backupCustomDocument(doc: PdfDocument, ctx: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    const out = doc.encrypted ? doc.bytes : await writeAnnotations(doc.bytes, doc.annotations);
    await vscode.workspace.fs.writeFile(ctx.destination, out);
    return {
      id: ctx.destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(ctx.destination);
        } catch {
          /* already deleted */
        }
      },
    };
  }

  // ------------------------------------------------------------------ export

  async exportNotes(doc: PdfDocument): Promise<void> {
    const md = toMarkdown(baseName(doc.uri), doc.annotations);
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Save as Markdown (.md)', id: 'file' },
        { label: 'Copy to clipboard', id: 'clipboard' },
      ],
      { placeHolder: 'Export notes and quoted passages' },
    );
    if (!choice) return;
    if (choice.id === 'clipboard') {
      await vscode.env.clipboard.writeText(md);
      void vscode.window.showInformationMessage('Notes copied to clipboard.');
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: doc.uri.with({ path: doc.uri.path.replace(/\.pdf$/i, '') + '-notes.md' }),
      filters: { Markdown: ['md'] },
      saveLabel: 'Export',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(md, 'utf8'));
    const open = await vscode.window.showInformationMessage(`Notes exported: ${baseName(target)}`, 'Open');
    if (open) await vscode.window.showTextDocument(target);
  }

  // -------------------------------------------------------------------- HTML

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const u = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const nonce = randomBytes(16).toString('hex');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `worker-src ${webview.cspSource} blob:`,
      `font-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource} data: blob:`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${u('viewer.css')}">
</head>
<body data-tool="select">
  <div id="app">
    <div id="hud" role="toolbar" aria-label="PDF controls">
      <span id="pageInfo"></span>
      <div class="hud-spacer"></div>
      <button id="noteTool" title="Add a note (N)">Note</button>
      <button id="toggleSide" title="Hide the annotations panel" aria-expanded="true" aria-controls="sidebar">Hide annotations</button>
      <button id="export" title="Export notes">Export</button>
      <span class="hud-separator"></span>
      <button id="zoomOut" title="Zoom out">−</button>
      <span id="zoomLabel">100 %</span>
      <button id="zoomIn" title="Zoom in">+</button>
      <button id="fit" title="Fit to width">Fit</button>
    </div>
    <div id="main">
      <div id="viewer"><div id="pages"></div></div>
      <aside id="sidebar">
        <div id="cards"></div>
        <p class="hint">Ctrl+Z to undo · Ctrl+S to save annotations to the PDF</p>
      </aside>
    </div>
    <div id="selectionPalette" role="toolbar" aria-label="Annotate selection" hidden>
      <div id="colors"></div>
      <div id="selectionActions">
        <button id="markHighlight" title="Highlight with selected color">▰ Highlight</button>
        <button id="markUnderline" title="Underline with selected color">U̲ Underline</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${u('pdfjs/pdf.min.js')}"></script>
  <!-- VS Code serves webview resources from a different origin. Initializing a
       pdf.js worker can stall for ~30 seconds. Preload its handler to use the
       local processing mode without that handshake. -->
  <script nonce="${nonce}" src="${u('pdfjs/pdf.worker.min.js')}"></script>
  <script nonce="${nonce}">window.PDFJS = { worker: "${u('pdfjs/pdf.worker.min.js')}", base: "${u('pdfjs')}/" };</script>
  <script nonce="${nonce}" src="${u('viewer.js')}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PdfAnnotatorProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PdfAnnotatorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('pdfAnnotator.exportNotes', () => {
      if (provider.active) return provider.exportNotes(provider.active);
      void vscode.window.showInformationMessage('Open a PDF with PDF Annotator first.');
    }),
  );
}

export function deactivate(): void {}
