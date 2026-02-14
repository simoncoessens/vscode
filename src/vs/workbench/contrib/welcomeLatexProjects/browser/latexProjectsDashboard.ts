/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, Dimension, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IWorkspacesService, IRecentFolder, IRecentWorkspace, isRecentFolder, isRecentWorkspace } from '../../../../platform/workspaces/common/workspaces.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { LatexProjectsDashboardInput } from './latexProjectsDashboardInput.js';
import { URI } from '../../../../base/common/uri.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';

type RecentEntry = (IRecentFolder | IRecentWorkspace) & { id: string };

export class LatexProjectsDashboard extends EditorPane {

	static readonly ID = 'latexProjectsDashboard';

	private container!: HTMLElement;
	private projectList!: HTMLElement;
	private searchInput!: HTMLInputElement;
	private searchWrap!: HTMLElement;
	private sectionLabel!: HTMLElement;
	private emptyState!: HTMLElement;

	private readonly contentDisposables = this._register(new DisposableStore());

	private recentlyOpened: Promise<{ workspaces: Array<IRecentWorkspace | IRecentFolder> }>;
	private projects: RecentEntry[] = [];
	private filteredProjects: RecentEntry[] = [];
	private searchQuery: string = '';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IHostService private readonly hostService: IHostService,
		@ILabelService private readonly labelService: ILabelService,
		@IFileService private readonly fileService: IFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super(LatexProjectsDashboard.ID, group, telemetryService, themeService, storageService);

		this.recentlyOpened = this.workspacesService.getRecentlyOpened();
		this._register(this.workspacesService.onDidChangeRecentlyOpened(() => {
			this.recentlyOpened = this.workspacesService.getRecentlyOpened();
			this.refreshProjects();
		}));
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.folio-home'));
		this.buildLayout();
	}

	override async setInput(input: LatexProjectsDashboardInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.refreshProjects();
	}

	override layout(_dimension: Dimension): void {
		// CSS handles layout
	}

	override clearInput(): void {
		super.clearInput();
	}

	override focus(): void {
		super.focus();
	}

	// --- Build the DOM ---

	private buildLayout(): void {
		clearNode(this.container);
		this.contentDisposables.clear();

		const inner = append(this.container, $('.folio-home-inner'));

		// Brand
		const brand = append(inner, $('.folio-brand'));
		append(brand, $('.folio-brand-mark'));
		const brandName = append(brand, $('.folio-brand-name'));
		brandName.textContent = 'Folio';

		// New project button
		const newBtn = append(inner, $('button.folio-new-project'));
		const plusIcon = append(newBtn, $('span'));
		plusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(newBtn, document.createTextNode(localize('newProject', 'New Project')));

		this.contentDisposables.add(addDisposableListener(newBtn, EventType.CLICK, () => {
			this.createNewProject();
		}));

		// Search (hidden until we have projects)
		this.searchWrap = append(inner, $('.folio-search-wrap'));
		const searchIcon = append(this.searchWrap, $('span'));
		searchIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));

		this.searchInput = append(this.searchWrap, $('input.folio-search')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('searchPlaceholder', 'Search projects\u2026');

		this.contentDisposables.add(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.searchQuery = this.searchInput.value;
			this.filterAndRender();
		}));

		// Section label
		this.sectionLabel = append(inner, $('.folio-section-label'));

		// Project list
		this.projectList = append(inner, $('.folio-project-list'));

		// Empty state
		this.emptyState = append(inner, $('.folio-empty'));

		// Footer
		const footer = append(inner, $('.folio-footer'));
		const footerText = append(footer, $('.folio-footer-text'));
		footerText.textContent = 'Folio v1.0';
	}

	// --- Data ---

	private async refreshProjects(): Promise<void> {
		const recent = await this.recentlyOpened;

		this.projects = recent.workspaces
			.filter((item): item is IRecentFolder | IRecentWorkspace => isRecentFolder(item) || isRecentWorkspace(item))
			.map((item, index) => ({
				...item,
				id: `project-${index}`
			}));

		this.filterAndRender();
	}

	private filterAndRender(): void {
		let filtered = [...this.projects];

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			filtered = filtered.filter(p => this.getProjectName(p).toLowerCase().includes(q));
		}

		this.filteredProjects = filtered;
		this.render();
	}

	// --- Render ---

	private render(): void {
		const hasProjects = this.projects.length > 0;
		const hasResults = this.filteredProjects.length > 0;

		// Show search only when there are projects
		this.searchWrap.style.display = hasProjects ? '' : 'none';

		// Section label
		if (hasProjects) {
			this.sectionLabel.style.display = '';
			this.sectionLabel.textContent = localize('recentProjects', 'RECENT');
		} else {
			this.sectionLabel.style.display = 'none';
		}

		// Project list
		clearNode(this.projectList);
		if (hasResults) {
			for (const project of this.filteredProjects) {
				this.renderProjectItem(project);
			}
		}

		// Empty state
		clearNode(this.emptyState);
		if (!hasResults) {
			this.renderEmpty(hasProjects);
		}
	}

	private renderProjectItem(project: RecentEntry): void {
		const item = append(this.projectList, $('button.folio-project-item'));
		item.tabIndex = 0;

		// Icon
		const icon = append(item, $('.folio-project-icon'));
		const iconSpan = append(icon, $('span'));
		iconSpan.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));

		// Info
		const info = append(item, $('.folio-project-info'));
		const name = append(info, $('.folio-project-name'));
		name.textContent = this.getProjectName(project);

		const pathEl = append(info, $('.folio-project-path'));
		const uri = this.getProjectUri(project);
		pathEl.textContent = this.labelService.getUriLabel(uri, { noPrefix: true });

		// Remove button
		const removeBtn = append(item, $('button.folio-project-remove'));
		const removeIcon = append(removeBtn, $('span'));
		removeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));

		this.contentDisposables.add(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this.removeFromRecent(project);
		}));

		// Click to open
		this.contentDisposables.add(addDisposableListener(item, EventType.CLICK, () => {
			this.openProject(project);
		}));

		this.contentDisposables.add(addDisposableListener(item, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openProject(project);
			}
		}));
	}

	private renderEmpty(hasProjects: boolean): void {
		const iconWrap = append(this.emptyState, $('.folio-empty-icon'));
		const iconSpan = append(iconWrap, $('span'));
		iconSpan.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));

		const text = append(this.emptyState, $('.folio-empty-text'));
		if (hasProjects) {
			text.textContent = localize('noSearchResults', 'No projects match your search.');
		} else {
			text.textContent = localize('noProjectsYet', 'Create your first project to get started.');
		}
	}

	// --- Helpers ---

	private getProjectName(project: RecentEntry): string {
		if (project.label) {
			return project.label;
		}
		return this.labelService.getUriBasenameLabel(this.getProjectUri(project));
	}

	private getProjectUri(project: RecentEntry): URI {
		if (isRecentFolder(project)) {
			return project.folderUri;
		}
		return project.workspace.configPath;
	}

	private async openProject(project: RecentEntry): Promise<void> {
		const uri = this.getProjectUri(project);
		if (isRecentFolder(project)) {
			await this.hostService.openWindow([{ folderUri: uri }]);
		} else {
			await this.hostService.openWindow([{ workspaceUri: uri }]);
		}
	}

	private async removeFromRecent(project: RecentEntry): Promise<void> {
		const uri = this.getProjectUri(project);
		await this.workspacesService.removeRecentlyOpened([uri]);
	}

	private async createNewProject(): Promise<void> {
		const homeDir = this.environmentService.userHome;
		const projectsBaseUri = URI.joinPath(homeDir, 'Folio Projects');

		try {
			const exists = await this.fileService.exists(projectsBaseUri);
			if (!exists) {
				await this.fileService.createFolder(projectsBaseUri);
			}
		} catch (error) {
			await this.dialogService.error(
				localize('createBaseFolderError', 'Failed to create projects folder'),
				localize('createBaseFolderErrorDetail', 'Could not create the Folio Projects folder: {0}', String(error))
			);
			return;
		}

		const projectName = await this.quickInputService.input({
			prompt: localize('projectNamePrompt', 'Enter a name for your new project'),
			placeHolder: localize('projectNamePlaceholder', 'My Project'),
			validateInput: async (value) => {
				if (!value || value.trim().length === 0) {
					return localize('projectNameRequired', 'Project name is required');
				}
				if (/[<>:"/\\|?*]/.test(value)) {
					return localize('projectNameInvalid', 'Project name contains invalid characters');
				}
				const projectUri = URI.joinPath(projectsBaseUri, value.trim());
				const exists = await this.fileService.exists(projectUri);
				if (exists) {
					return localize('projectNameExists', 'A project with this name already exists');
				}
				return null;
			}
		});

		if (!projectName) {
			return;
		}

		const projectUri = URI.joinPath(projectsBaseUri, projectName.trim());

		try {
			await this.fileService.createFolder(projectUri);

			const mainTexContent = this.getLatexTemplate(projectName.trim());
			const mainTexUri = URI.joinPath(projectUri, 'main.tex');
			await this.fileService.writeFile(mainTexUri, VSBuffer.fromString(mainTexContent));

			// Pre-create workspace settings so the new window opens clean
			const vscodeDir = URI.joinPath(projectUri, '.vscode');
			await this.fileService.createFolder(vscodeDir);
			const settingsUri = URI.joinPath(vscodeDir, 'settings.json');
			const initialSettings = {
				'workbench.startupEditor': 'none',
				'latex-workshop.latex.autoBuild.run': 'onSave',
			};
			await this.fileService.writeFile(settingsUri, VSBuffer.fromString(JSON.stringify(initialSettings, null, '\t')));

			await this.hostService.openWindow([{ folderUri: projectUri }]);
		} catch (error) {
			await this.dialogService.error(
				localize('createProjectError', 'Failed to create project'),
				localize('createProjectErrorDetail', 'Could not create the project folder: {0}', String(error))
			);
		}
	}

	private getLatexTemplate(projectName: string): string {
		return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{${projectName}}
\\author{}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Your abstract here.
\\end{abstract}

\\section{Introduction}

Start writing your document here.

\\section{Conclusion}

Your conclusion.

\\end{document}
`;
	}
}
