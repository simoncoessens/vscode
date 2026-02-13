# Folio — A LaTeX Editor for the Agentic Era

Folio is a VS Code fork purpose-built for LaTeX writing. The goal is an Overleaf-like experience — simple, focused, distraction-free — but designed around **agentic use in the terminal** (e.g. Claude Code) for AI-assisted LaTeX authoring. The editor stays minimal; the terminal is where the real work happens.

---

# VS Code Development Setup

## Prerequisites

- **Node.js 22** (required, v24 does NOT work)
- **Xcode** (not just Command Line Tools)

## PATH Configuration

Anaconda's tools conflict with native module builds. Always use this PATH when working on VS Code:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin:$PATH"
```

Or add to `~/.zshrc` for persistence:
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

## Initial Setup (First Time)

```bash
# Clean install
rm -rf node_modules build/node_modules

# Install with correct PATH
export PATH="/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin:$PATH"
npm install

# Compile
npm run compile
```

## Common Commands

| Command | Description |
|---------|-------------|
| `npm run compile` | Full compilation |
| `npm run watch` | Watch mode (auto-recompiles on changes) |
| `./scripts/code.sh` | Run VS Code from source |
| `npm rebuild` | Rebuild native modules |

## Folio: Overleaf-like LaTeX Editor (Custom Fork)

This VS Code fork is being transformed into **Folio**, a focused LaTeX editing experience similar to Overleaf. The main customization lives in `src/vs/workbench/contrib/latexPdfViewer/browser/latexPdfViewer.contribution.ts`.

### Architecture

The `LatexPdfViewerContribution` workbench contribution auto-activates when a workspace with folders is opened. It creates an Overleaf-style layout with three editor groups:

- **Top-left**: LaTeX editor (single file at a time, Overleaf-style)
- **Bottom-left**: Always-open terminal (for compiling / Claude Code interaction)
- **Right**: Chromeless PDF viewer (via LaTeX Workshop extension)

### Key Changes

#### 1. Chromeless PDF Viewer (`latexPdfViewer.contribution.ts`)
- PDF opens in a locked, sticky right group with all chrome hidden (no tab bar, no toolbar, no watermark)
- Uses a `chromeless-pdf-viewer` CSS class + injected stylesheet with `!important` rules
- MutationObservers maintain the class if VS Code's layout engine resets it

#### 2. Layout Engine Override (`editorGroupView.ts`)
- The `layout()` method checks for the `chromeless-pdf-viewer` class
- When present, `effectiveTitleHeight = 0` so the editor pane gets the full available height
- This ensures both the container AND the webview/PDF renderer fill the space correctly

#### 3. Editor Group Locking (`editorGroupView.ts`, `editorPart.ts`)
- `closeEditor()`, `closeEditors()`, `closeAllEditors()` return early for locked groups
- `removeGroup()` skips locked groups
- Middle-click close disabled for locked groups
- Empty locked groups are not removed

#### 4. Terminal Integration
- Terminal auto-opens in a group created by splitting the editor group downward (`addGroup(editorGroup, GroupDirection.DOWN)`)
- Terminal group is locked and chromeless
- Non-terminal editors opened in the terminal group are moved to the editor group

#### 5. Focused Mode (workspace settings applied on activation)
- `workbench.activityBar.location: 'hidden'` — removes the icon sidebar (Explorer, Search, Debug icons)
- `workbench.layoutControl.enabled: false` — removes top-right layout toggle buttons
- `editor.minimap.enabled: false` — removes minimap
- `files.exclude` — hides LaTeX build artifacts (`.aux`, `.log`, `.synctex.gz`, etc.) and `.pdf` from the explorer

#### 6. Enforcement System
- Max 3 editor groups enforced (extra groups merged into editor group)
- PDF group: only `.pdf` editors allowed, re-locks if unlocked, re-sticks if unsticked
- Terminal group: only terminal editors allowed, re-locks if unlocked
- Editor group: single editor at a time (closes previous when new file opened)
- `splitOnDragAndDrop: false` and `closeEmptyGroups: false` enforced globally

### Files Modified

| File | Changes |
|------|---------|
| `src/vs/workbench/contrib/latexPdfViewer/browser/latexPdfViewer.contribution.ts` | Main contribution (PDF viewer, terminal, focused mode, enforcement) |
| `src/vs/workbench/browser/parts/editor/editorGroupView.ts` | Locked group protection + chromeless layout override |
| `src/vs/workbench/browser/parts/editor/editorPart.ts` | Locked group removal prevention |
| `src/vs/workbench/workbench.common.main.ts` | Registration of the latexPdfViewer contribution |

### Group Identification

Groups are identified by **content** (not indices) to survive workspace restore:
- PDF group: has an editor with `.pdf` resource
- Terminal group: has an editor with `typeId === 'workbench.editors.terminal'`
- Editor group: the first unlocked group

## Troubleshooting

### Native module build failures (libtool errors)
The error `libtool: file is not an object file` means Anaconda's libtool is being used instead of Xcode's. Fix by ensuring `/usr/bin` comes before Anaconda in PATH.

### Node version errors
VS Code requires Node.js 22. Check `.nvmrc` for exact version. Install with:
```bash
brew install node@22
```
