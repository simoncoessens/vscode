/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, FileChangeType } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IEditorGroupsService, GroupOrientation, GroupDirection, IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { isGroupEditorOpenEvent } from '../../../common/editor/editorGroupModel.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { editorGroupToColumn } from '../../../services/editor/common/editorGroupColumn.js';

const CHROMELESS_CLASS = 'chromeless-pdf-viewer';

class LatexPdfViewerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.latexPdfViewer';

	private pdfOpened = false;
	private terminalOpened = false;
	private chromeStyleInjected = false;
	private enforcementSetUp = false;

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this.run();
	}

	private async run(): Promise<void> {
		await this.lifecycleService.when(LifecyclePhase.Restored);

		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return;
		}

		this.injectFolioStylesheet();
		await this.setupFocusedMode();

		// Check if a PDF editor is already open (workspace restore case)
		let pdfGroup: IEditorGroup | undefined;
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor.resource?.path.endsWith('.pdf')) {
					this.pdfOpened = true;
					pdfGroup = group;
					group.lock(true);
					break;
				}
			}
			if (pdfGroup) {
				break;
			}
		}

		if (pdfGroup) {
			// Restore case: PDF already open, ensure terminal + enforcement
			await this.ensureTerminal();
			this.setupEnforcement();
			return;
		}

		const folders = this.contextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}

		const rootUri = folders[0].uri;
		const pdfUri = await this.findPdf(rootUri);

		if (pdfUri) {
			await this.openPdfViewer(pdfUri);
		} else {
			this.watchForPdf(rootUri);
		}
	}

	private async findPdf(rootUri: URI): Promise<URI | undefined> {
		try {
			const rootStat = await this.fileService.resolve(rootUri);
			if (!rootStat.children) {
				return undefined;
			}

			const texFiles: string[] = [];
			let hasMainPdf = false;
			const pdfFiles: string[] = [];

			for (const child of rootStat.children) {
				if (!child.isDirectory && child.name) {
					if (child.name.endsWith('.tex')) {
						texFiles.push(child.name.replace(/\.tex$/, ''));
					}
					if (child.name === 'main.pdf') {
						hasMainPdf = true;
					}
					if (child.name.endsWith('.pdf')) {
						pdfFiles.push(child.name);
					}
				}
			}

			if (hasMainPdf) {
				return URI.joinPath(rootUri, 'main.pdf');
			}

			for (const texName of texFiles) {
				const matchingPdf = `${texName}.pdf`;
				if (pdfFiles.includes(matchingPdf)) {
					return URI.joinPath(rootUri, matchingPdf);
				}
			}

			if (pdfFiles.length > 0) {
				return URI.joinPath(rootUri, pdfFiles[0]);
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	private async openPdfViewer(pdfUri: URI): Promise<void> {
		if (this.pdfOpened) {
			return;
		}
		this.pdfOpened = true;

		try {
			// Open PDF in a side group (creates the right group)
			const editor = await this.editorService.openEditor(
				{
					resource: pdfUri,
					options: {
						pinned: true,
						override: 'latex-workshop-pdf-hook',
					}
				},
				SIDE_GROUP
			);

			if (editor) {
				const group = editor.group;
				if (group) {
					group.lock(true);
					group.stickEditor(editor.input);
				}
			}

			// Create the terminal below the editor
			await this.ensureTerminal();

			// Apply the final 50/50 horizontal layout with 70/30 vertical split on the left
			this.editorGroupsService.applyLayout({
				orientation: GroupOrientation.HORIZONTAL,
				groups: [
					{ size: 0.5, groups: [{ size: 0.7 }, { size: 0.3 }] },
					{ size: 0.5 }
				]
			});

			this.setupEnforcement();
		} catch {
			this.pdfOpened = false;
		}
	}

	private async ensureTerminal(): Promise<void> {
		if (this.terminalOpened) {
			return;
		}

		// Check if a terminal is already open
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor.typeId === 'workbench.editors.terminal') {
					this.terminalOpened = true;
					group.lock(true);
					this.hideGroupChrome(group);
					return;
				}
			}
		}

		this.terminalOpened = true;

		// Find the editor group (first non-locked, non-PDF group)
		const editorGroup = this.findEditorGroup();
		if (!editorGroup) {
			this.terminalOpened = false;
			return;
		}

		try {
			// Split the editor group downward to create a terminal area
			const terminalGroup = this.editorGroupsService.addGroup(editorGroup, GroupDirection.DOWN);

			const column = editorGroupToColumn(this.editorGroupsService, terminalGroup);
			await this.terminalService.createTerminal({
				location: { viewColumn: column, preserveFocus: true }
			});

			// Lock and protect the terminal group
			terminalGroup.lock(true);
			for (const ed of terminalGroup.editors) {
				if (!terminalGroup.isSticky(ed)) {
					terminalGroup.stickEditor(ed);
				}
			}

			// Hide chrome on the terminal group
			this.hideGroupChrome(terminalGroup);
		} catch {
			this.terminalOpened = false;
		}
	}

	private setupEnforcement(): void {
		if (this.enforcementSetUp) {
			return;
		}
		this.enforcementSetUp = true;

		// 1. Hide chrome on the PDF group
		const pdfGroup = this.findPdfGroup();
		if (pdfGroup) {
			this.hideGroupChrome(pdfGroup);
		}

		// 2. Enforce part options
		this._register(this.editorGroupsService.enforcePartOptions({
			splitOnDragAndDrop: false,
			closeEmptyGroups: false,
		}));

		// 3. Guard against extra groups — merge back into the editor group
		this._register(this.editorGroupsService.onDidAddGroup(newGroup => {
			const groups = this.editorGroupsService.groups;
			if (groups.length > 3) {
				const editorGroup = this.findEditorGroup() || groups[0];
				this.editorGroupsService.mergeGroup(newGroup, editorGroup);
			}
		}));

		// 4. Guard PDF group
		if (pdfGroup) {
			this._register(pdfGroup.onDidModelChange(e => {
				if (e.kind === GroupModelChangeKind.GROUP_LOCKED && !pdfGroup.isLocked) {
					pdfGroup.lock(true);
					return;
				}

				if (e.kind === GroupModelChangeKind.EDITOR_STICKY) {
					for (const editor of pdfGroup.editors) {
						if (!pdfGroup.isSticky(editor)) {
							pdfGroup.stickEditor(editor);
						}
					}
					return;
				}

				if (!isGroupEditorOpenEvent(e)) {
					return;
				}
				const openedEditor = e.editor;
				if (openedEditor.resource?.path.endsWith('.pdf')) {
					return;
				}
				const editorGroup = this.findEditorGroup();
				if (editorGroup) {
					pdfGroup.moveEditor(openedEditor, editorGroup);
				}
			}));
		}

		// 5. Guard terminal group
		const termGroup = this.findTerminalGroup();
		if (termGroup) {
			this._register(termGroup.onDidModelChange(e => {
				if (e.kind === GroupModelChangeKind.GROUP_LOCKED && !termGroup.isLocked) {
					termGroup.lock(true);
					return;
				}

				if (!isGroupEditorOpenEvent(e)) {
					return;
				}
				const openedEditor = e.editor;
				if (openedEditor.typeId === 'workbench.editors.terminal') {
					return;
				}
				const editorGroup = this.findEditorGroup();
				if (editorGroup) {
					termGroup.moveEditor(openedEditor, editorGroup);
				}
			}));
		}

		// 6. Enforce single editor in the editor group (Overleaf-style)
		const editorGroup = this.findEditorGroup();
		if (editorGroup) {
			this._register(editorGroup.onDidModelChange(e => {
				if (!isGroupEditorOpenEvent(e)) {
					return;
				}
				const openedEditor = e.editor;
				const editorsToClose = editorGroup.editors.filter(ed => ed !== openedEditor);
				if (editorsToClose.length > 0) {
					editorGroup.closeEditors(editorsToClose);
				}
			}));
		}
	}

	// --- Group identification by content (robust across restores) ---

	private findEditorGroup(): IEditorGroup | undefined {
		// The editor group is the one that is NOT locked (or the first one if all are locked)
		const groups = this.editorGroupsService.groups;
		return groups.find(g => !g.isLocked) || groups[0];
	}

	private findPdfGroup(): IEditorGroup | undefined {
		return this.editorGroupsService.groups.find(g =>
			g.editors.some(e => e.resource?.path.endsWith('.pdf'))
		);
	}

	private findTerminalGroup(): IEditorGroup | undefined {
		return this.editorGroupsService.groups.find(g =>
			g.editors.some(e => e.typeId === 'workbench.editors.terminal')
		);
	}

	// --- Folio global visual identity ---

	private injectFolioStylesheet(): void {
		const style = document.createElement('style');
		style.id = 'folio-global-css';
		style.textContent = `
			/* ===== Folio — Visual Identity ===== */

			/* Hide the bottom panel entirely — terminal lives in editor group */
			.monaco-workbench .part.panel {
				display: none !important;
			}
			.monaco-workbench .part.panel ~ .monaco-sash {
				display: none !important;
			}

			/* Refined scrollbars — thin, rounded, subtle */
			.monaco-workbench .monaco-scrollable-element > .scrollbar > .slider {
				border-radius: 20px !important;
			}
			.monaco-workbench .monaco-scrollable-element > .scrollbar.vertical {
				width: 8px !important;
			}
			.monaco-workbench .monaco-scrollable-element > .scrollbar.vertical > .slider {
				width: 5px !important;
				left: 50% !important;
				transform: translateX(-50%) !important;
			}
			.monaco-workbench .monaco-scrollable-element > .scrollbar.horizontal {
				height: 8px !important;
			}
			.monaco-workbench .monaco-scrollable-element > .scrollbar.horizontal > .slider {
				height: 5px !important;
				top: 50% !important;
				transform: translateY(-50%) !important;
			}

			/* Subtle window title text */
			.monaco-workbench .part.titlebar .window-title {
				font-size: 12px !important;
				opacity: 0.5 !important;
				letter-spacing: 0.02em !important;
			}

			/* Smooth sash transitions on hover */
			.monaco-workbench .monaco-sash {
				transition: background-color 0.15s ease !important;
			}

			/* Softer explorer sidebar header */
			.monaco-workbench .composite.title {
				text-transform: none !important;
				letter-spacing: 0.01em !important;
			}

			/* ===== Editor title bar cleanup ===== */

			/* Hide specific unwanted editor title actions (blacklist approach).
			   Anything not listed here stays visible (e.g. compile button). */
			.title-actions .action-item:has(.codicon-split-horizontal),
			.title-actions .action-item:has(.codicon-toolbar-more),
			.title-actions .action-item:has(.codicon-go-to-file),
			.title-actions .action-item:has(.codicon-close-all),
			.title-actions .action-item:has(.codicon-open-preview),
			.title-actions .action-item:has(.codicon-book),
			.title-actions .action-item:has(.codicon-search),
			.editor-actions .action-item:has(.codicon-split-horizontal),
			.editor-actions .action-item:has(.codicon-toolbar-more),
			.editor-actions .action-item:has(.codicon-go-to-file),
			.editor-actions .action-item:has(.codicon-close-all),
			.editor-actions .action-item:has(.codicon-open-preview),
			.editor-actions .action-item:has(.codicon-book),
			.editor-actions .action-item:has(.codicon-search) {
				display: none !important;
			}

			/* Hide close button on the single tab — we enforce single-editor mode */
			.editor-group-container:not(.chromeless-pdf-viewer) .tab .tab-close {
				display: none !important;
			}

			/* ===== Explorer sidebar cleanup ===== */

			/* Hide OUTLINE and TIMELINE panes from explorer */
			.split-view-view:has(> .pane[id="outline"]),
			.split-view-view:has(> .pane[id="timeline"]) {
				display: none !important;
			}

			/* ===== Title bar cleanup ===== */

			/* Hide global actions in title bar (accounts, chat, settings gear) */
			.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-right > .action-toolbar-container {
				display: none !important;
			}
		`;
		document.head.appendChild(style);
		this._register({ dispose: () => style.remove() });
	}

	// --- Chrome hiding ---

	private injectChromelessStylesheet(): void {
		if (this.chromeStyleInjected) {
			return;
		}
		this.chromeStyleInjected = true;

		const style = document.createElement('style');
		style.id = 'latex-pdf-chromeless-css';
		style.textContent = `
			.editor-group-container.${CHROMELESS_CLASS} > .title {
				display: none !important;
				height: 0 !important;
				min-height: 0 !important;
				overflow: hidden !important;
				border: none !important;
			}
			.editor-group-container.${CHROMELESS_CLASS} > .title::after {
				display: none !important;
			}
			.editor-group-container.${CHROMELESS_CLASS} > .editor-group-container-toolbar {
				display: none !important;
			}
			.editor-group-container.${CHROMELESS_CLASS} > .editor-group-watermark {
				display: none !important;
			}
			.editor-group-container.${CHROMELESS_CLASS} > .editor-container {
				height: 100% !important;
				top: 0 !important;
			}
		`;
		document.head.appendChild(style);
		this._register({ dispose: () => style.remove() });
	}

	private hideGroupChrome(group: IEditorGroup | undefined): void {
		if (!group) {
			return;
		}

		const groupView = group as unknown as IEditorGroupView;
		const container = groupView.element;
		if (!container) {
			return;
		}

		this.injectChromelessStylesheet();

		// Skip if already chromeless
		if (container.classList.contains(CHROMELESS_CLASS)) {
			return;
		}

		container.classList.add(CHROMELESS_CLASS);

		// Force relayout so the layout engine allocates full height (titleHeight=0)
		groupView.relayout();

		// Ensure the class stays applied
		const classObserver = new MutationObserver(() => {
			if (!container.classList.contains(CHROMELESS_CLASS)) {
				container.classList.add(CHROMELESS_CLASS);
			}
		});
		classObserver.observe(container, { attributes: true, attributeFilter: ['class'] });
		this._register({ dispose: () => classObserver.disconnect() });

		// Belt-and-suspenders: override inline styles on .editor-container
		const editorContainerEl = container.querySelector('.editor-container') as HTMLElement | null;
		if (editorContainerEl) {
			editorContainerEl.style.setProperty('height', '100%', 'important');
			editorContainerEl.style.setProperty('top', '0px', 'important');

			const styleObserver = new MutationObserver(() => {
				if (editorContainerEl.style.getPropertyPriority('height') !== 'important' ||
					editorContainerEl.style.getPropertyValue('top') !== '0px') {
					editorContainerEl.style.setProperty('height', '100%', 'important');
					editorContainerEl.style.setProperty('top', '0px', 'important');
				}
			});
			styleObserver.observe(editorContainerEl, { attributes: true, attributeFilter: ['style'] });
			this._register({ dispose: () => styleObserver.disconnect() });
		}
	}

	// --- Focused mode & artifact hiding ---

	private async setupFocusedMode(): Promise<void> {
		// Hide activity bar (the icon strip: Explorer, Search, Debug, Extensions icons)
		await this.configurationService.updateValue('workbench.activityBar.location', 'hidden', ConfigurationTarget.WORKSPACE);

		// Hide layout control buttons (top-right layout toggles)
		await this.configurationService.updateValue('workbench.layoutControl.enabled', false, ConfigurationTarget.WORKSPACE);

		// Hide minimap for a cleaner editor
		await this.configurationService.updateValue('editor.minimap.enabled', false, ConfigurationTarget.WORKSPACE);

		// Word wrap for readable LaTeX source (like Overleaf)
		await this.configurationService.updateValue('editor.wordWrap', 'on', ConfigurationTarget.WORKSPACE);

		// --- Strip VS Code chrome ---

		// Hide status bar — clean bottom edge
		await this.configurationService.updateValue('workbench.statusBar.visible', false, ConfigurationTarget.WORKSPACE);

		// Hide breadcrumbs
		await this.configurationService.updateValue('breadcrumbs.enabled', false, ConfigurationTarget.WORKSPACE);

		// Single-tab mode — shows filename + compile button, no multi-tab clutter
		await this.configurationService.updateValue('workbench.editor.showTabs', 'single', ConfigurationTarget.WORKSPACE);

		// Hide command center from title bar
		await this.configurationService.updateValue('window.commandCenter', false, ConfigurationTarget.WORKSPACE);

		// Clean window title — Folio branding
		await this.configurationService.updateValue('window.title', '${dirty}${activeEditorShort}${separator}Folio', ConfigurationTarget.WORKSPACE);

		// --- Refined editor experience ---

		// No scroll past end of file
		await this.configurationService.updateValue('editor.scrollBeyondLastLine', false, ConfigurationTarget.WORKSPACE);

		// Smooth cursor
		await this.configurationService.updateValue('editor.cursorBlinking', 'smooth', ConfigurationTarget.WORKSPACE);
		await this.configurationService.updateValue('editor.cursorSmoothCaretAnimation', 'on', ConfigurationTarget.WORKSPACE);

		// Subtle current-line highlight (gutter only)
		await this.configurationService.updateValue('editor.renderLineHighlight', 'gutter', ConfigurationTarget.WORKSPACE);

		// Remove glyph margin for a tighter gutter
		await this.configurationService.updateValue('editor.glyphMargin', false, ConfigurationTarget.WORKSPACE);

		// Hide everything except source files from the file explorer.
		// Only .tex, .bib, .cls, .sty, images, and text files should be visible.
		const excludePatterns: Record<string, boolean> = {
			// LaTeX build artifacts
			'**/*.aux': true,
			'**/*.log': true,
			'**/*.synctex.gz': true,
			'**/*.fls': true,
			'**/*.fdb_latexmk': true,
			'**/*.out': true,
			'**/*.toc': true,
			'**/*.lof': true,
			'**/*.lot': true,
			'**/*.bbl': true,
			'**/*.blg': true,
			'**/*.nav': true,
			'**/*.snm': true,
			'**/*.vrb': true,
			'**/*.idx': true,
			'**/*.ind': true,
			'**/*.ilg': true,
			'**/*.glg': true,
			'**/*.glo': true,
			'**/*.gls': true,
			'**/*.ist': true,
			'**/*.acn': true,
			'**/*.acr': true,
			'**/*.alg': true,
			'**/*.run.xml': true,
			'**/*.bcf': true,
			'**/*.xdv': true,
			'**/*-blx.bib': true,
			// PDF files (we handle PDF viewing internally)
			'**/*.pdf': true,
			// Config/metadata folders
			'**/.vscode': true,
			'**/.claude': true,
			'**/.git': true,
			'**/.latexmkrc': true,
			'**/latexmkrc': true,
		};
		await this.configurationService.updateValue('files.exclude', excludePatterns, ConfigurationTarget.WORKSPACE);
	}

	// --- PDF file watching ---

	private watchForPdf(rootUri: URI): void {
		// Create the 3-group layout immediately so the terminal is available while waiting
		this.editorGroupsService.applyLayout({
			orientation: GroupOrientation.HORIZONTAL,
			groups: [
				{ size: 0.5, groups: [{ size: 0.7 }, { size: 0.3 }] },
				{ size: 0.5 }
			]
		});

		// Lock the right group (PDF placeholder) and hide chrome
		const groups = this.editorGroupsService.groups;
		if (groups.length >= 3) {
			groups[2].lock(true);
			this.hideGroupChrome(groups[2]);
		}

		// Open terminal while waiting for PDF
		this.ensureTerminal();

		// Watch for PDF file creation
		this._register(this.fileService.onDidFilesChange(e => {
			if (this.pdfOpened) {
				return;
			}

			if (e.affects(rootUri, FileChangeType.ADDED, FileChangeType.UPDATED)) {
				this.findPdf(rootUri).then(pdfUri => {
					if (pdfUri) {
						this.openPdfInLockedGroup(pdfUri);
					}
				});
			}
		}));
	}

	private async openPdfInLockedGroup(pdfUri: URI): Promise<void> {
		if (this.pdfOpened) {
			return;
		}
		this.pdfOpened = true;

		try {
			// Find the locked empty group (the PDF placeholder on the right)
			const groups = this.editorGroupsService.groups;
			const lockedEmptyGroup = groups.find(g => g.isLocked && g.isEmpty);
			const targetGroup = lockedEmptyGroup || groups[groups.length - 1];

			if (targetGroup) {
				if (targetGroup.isLocked) {
					targetGroup.lock(false);
				}

				const editor = await this.editorService.openEditor(
					{
						resource: pdfUri,
						options: {
							pinned: true,
							override: 'latex-workshop-pdf-hook',
						}
					},
					targetGroup.id
				);

				targetGroup.lock(true);
				if (editor?.input) {
					targetGroup.stickEditor(editor.input);
				}

				this.setupEnforcement();
			}
		} catch {
			this.pdfOpened = false;
		}
	}
}

registerWorkbenchContribution2(
	LatexPdfViewerContribution.ID,
	LatexPdfViewerContribution,
	WorkbenchPhase.AfterRestored
);
