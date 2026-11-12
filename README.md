# PDF Annotator for VS Code

Read and annotate PDFs without leaving Visual Studio Code. Inspired by Zotero's annotation workflow, PDF Annotator supports text highlights, underlines, sticky notes, comments, and Markdown note exports.

## Features

- **Contextual annotations:** select text and choose a highlight color or underline it from a small floating palette.
- **Smooth PDF reading:** continuous scrolling, mouse-centered zoom, and a blurred preview while pages are re-rendered.
- **Editable notes:** add comments to highlights or place a note directly on a page.
- **Portable annotations:** save highlights, underlines, and notes as standard PDF annotations.
- **Markdown export:** export quoted passages and comments, grouped by page.
- **Offline by default:** PDF rendering and annotation processing run locally in VS Code.

## Installation

- **From a VSIX:** open the Command Palette and run `Extensions: Install from VSIX...`.
- **From source:** run `npm ci`, then press `F5` to launch an Extension Development Host, or run `npm run package` to build a VSIX.

## Usage

Right-click a PDF and select **Open With... → PDF Annotator**. To use it for all PDFs, choose **Configure Default Editor for '*.pdf'**.

| Action | How to use it |
| --- | --- |
| Search PDF text | `Ctrl+F` (`Cmd+F` on macOS); Enter / Shift+Enter moves between matches, Escape closes search. Options: highlight all, match case, match accents and diacritics, and whole words. |
| Highlight text | Select a passage, then click a color in the contextual palette, or press `H` |
| Underline text | Select a passage and click **Underline**, or press `U` |
| Add a note | Click **Note** in the toolbar (or press `N`), then click on the page |
| Return to selection mode | Press `V` or `Escape` |
| Add a comment | Use the text field in the annotation card in the sidebar |
| Change an annotation's color | Select the annotation, then choose a color in its card |
| Delete an annotation | Click the **×** button on its card, or press `Delete` when selected |
| Undo / redo | `Ctrl+Z` / `Ctrl+Y` (`Cmd` on macOS), using VS Code's native undo history |
| Save | `Ctrl+S` to write annotations into the PDF |
| Export notes | Click **Export** or run `PDF Annotator: Export Notes and Quotes` to save Markdown or copy to clipboard |

The **Show annotations / Hide annotations** button toggles the annotation sidebar.

## Annotation storage

The extension writes standard PDF annotations (`/Highlight`, `/Underline`, and `/Text`, including `QuadPoints` and appearance streams). They can be read by compatible PDF applications, including Zotero and Acrobat. Quoted text is also stored in a private `/VSPdfQuote` field, which other readers can safely ignore.

Existing highlights, underlines, and notes are imported when a PDF is opened. If the PDF cannot be modified, for example because it is encrypted, annotations are saved to a neighboring `<filename>.pdf.annotations.json` file and restored on the next open.

## Development

```bash
npm ci
npm run typecheck
npm run compile
npm run package
```

## License

MIT. See the `LICENSE` file in the project repository.
