/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, append, clearNode, EventType } from '../../../../base/browser/dom.js';
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
import { Dimension } from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';

type RecentEntry = (IRecentFolder | IRecentWorkspace) & { id: string };

type SortColumn = 'title' | 'owner' | 'lastModified';
type SortDirection = 'asc' | 'desc';

type NavView = 'all' | 'yours' | 'trashed';

export class LatexProjectsDashboard extends EditorPane {

	static readonly ID = 'latexProjectsDashboard';

	private container!: HTMLElement;
	private mainContent!: HTMLElement;
	private tableBody!: HTMLTableSectionElement;
	private searchInput!: HTMLInputElement;
	private headerElement!: HTMLElement;
	private subtitleElement!: HTMLElement;

	private readonly contentDisposables = this._register(new DisposableStore());

	private recentlyOpened: Promise<{ workspaces: Array<IRecentWorkspace | IRecentFolder> }>;
	private projects: RecentEntry[] = [];
	private filteredProjects: RecentEntry[] = [];

	private currentView: NavView = 'all';
	private sortColumn: SortColumn = 'lastModified';
	private sortDirection: SortDirection = 'desc';
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
		this.container = append(parent, $('.latex-dashboard'));
		this.buildContent();
	}

	override async setInput(input: LatexProjectsDashboardInput, options: undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.refreshProjects();
	}

	override layout(_dimension: Dimension): void {
		// The layout is handled by CSS flexbox
	}

	override clearInput(): void {
		super.clearInput();
	}

	override focus(): void {
		super.focus();
		this.searchInput?.focus();
	}

	private buildContent(): void {
		clearNode(this.container);
		this.contentDisposables.clear();

		// Build sidebar
		this.buildSidebar();

		// Build main content area
		this.buildMainContent();
	}

	private buildSidebar(): void {
		const sidebar = append(this.container, $('.latex-dashboard-sidebar'));

		// Logo
		const logo = append(sidebar, $('.latex-dashboard-logo'));
		logo.textContent = 'Folio';

		// New Project button
		const newProjectBtn = append(sidebar, $('button.latex-dashboard-new-project'));
		const plusIcon = append(newProjectBtn, $('span'));
		plusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		append(newProjectBtn, document.createTextNode(localize('newProject', 'New Project')));

		this.contentDisposables.add(addDisposableListener(newProjectBtn, EventType.CLICK, () => {
			this.createNewProject();
		}));

		// Navigation
		const nav = append(sidebar, $('.latex-dashboard-nav'));

		const navItems: { id: NavView; label: string; icon: ThemeIcon }[] = [
			{ id: 'all', label: localize('allProjects', 'All Projects'), icon: Codicon.files },
			{ id: 'yours', label: localize('yourProjects', 'Your Projects'), icon: Codicon.account },
			{ id: 'trashed', label: localize('archived', 'Archived'), icon: Codicon.archive },
		];

		for (const item of navItems) {
			const navItem = append(nav, $('button.latex-dashboard-nav-item'));
			if (item.id === this.currentView) {
				navItem.classList.add('active');
			}
			const icon = append(navItem, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(item.icon));
			append(navItem, document.createTextNode(item.label));

			this.contentDisposables.add(addDisposableListener(navItem, EventType.CLICK, () => {
				this.setView(item.id);
			}));
		}

		// Sidebar footer
		const footer = append(sidebar, $('.latex-dashboard-sidebar-footer'));
		const version = append(footer, $('.latex-dashboard-version'));
		version.textContent = 'Folio v1.0';
	}

	private buildMainContent(): void {
		this.mainContent = append(this.container, $('.latex-dashboard-main'));

		// Header
		this.headerElement = append(this.mainContent, $('.latex-dashboard-header'));
		this.headerElement.textContent = this.getHeaderText();

		// Subtitle
		this.subtitleElement = append(this.mainContent, $('.latex-dashboard-subtitle'));
		this.subtitleElement.textContent = this.getSubtitleText();

		// Search
		const searchContainer = append(this.mainContent, $('.latex-dashboard-search-container'));
		const searchWrapper = append(searchContainer, $('.latex-dashboard-search-wrapper'));

		const searchIcon = append(searchWrapper, $('span.latex-dashboard-search-icon'));
		searchIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.search));

		this.searchInput = append(searchWrapper, $('input.latex-dashboard-search')) as HTMLInputElement;
		this.searchInput.type = 'text';
		this.searchInput.placeholder = localize('searchPlaceholder', 'Search projects...');

		this.contentDisposables.add(addDisposableListener(this.searchInput, EventType.INPUT, () => {
			this.searchQuery = this.searchInput.value;
			this.filterAndRenderProjects();
		}));

		// Table container
		const tableContainer = append(this.mainContent, $('.latex-dashboard-table-container'));
		const table = append(tableContainer, $('table.latex-dashboard-table'));

		// Table header
		const thead = append(table, $('thead'));
		const headerRow = append(thead, $('tr'));

		const columns: { id: SortColumn; label: string }[] = [
			{ id: 'title', label: localize('project', 'Project') },
			{ id: 'owner', label: localize('owner', 'Owner') },
			{ id: 'lastModified', label: localize('lastModified', 'Last Modified') },
		];

		for (const col of columns) {
			const th = append(headerRow, $('th'));
			th.textContent = col.label;
			const sortIndicator = append(th, $('span.sort-indicator'));
			if (this.sortColumn === col.id) {
				th.classList.add('sorted');
				sortIndicator.textContent = this.sortDirection === 'asc' ? ' ↑' : ' ↓';
			}
			this.contentDisposables.add(addDisposableListener(th, EventType.CLICK, () => {
				this.toggleSort(col.id);
			}));
		}

		// Actions column header
		append(headerRow, $('th')).textContent = '';

		// Table body
		const tbody = append(table, $('tbody')) as HTMLTableSectionElement;
		this.tableBody = tbody;
	}

	private getHeaderText(): string {
		switch (this.currentView) {
			case 'all': return localize('allProjectsHeader', 'All Projects');
			case 'yours': return localize('yourProjectsHeader', 'Your Projects');
			case 'trashed': return localize('archivedHeader', 'Archived');
		}
	}

	private getSubtitleText(): string {
		const count = this.filteredProjects.length;
		switch (this.currentView) {
			case 'all':
				return count === 1
					? localize('oneProject', '1 project in your workspace')
					: localize('nProjects', '{0} projects in your workspace', count);
			case 'yours':
				return localize('yourProjectsSubtitle', 'Projects you own');
			case 'trashed':
				return localize('archivedSubtitle', 'Archived projects');
		}
	}

	private setView(view: NavView): void {
		this.currentView = view;
		this.buildContent();
		this.refreshProjects();
	}

	private toggleSort(column: SortColumn): void {
		if (this.sortColumn === column) {
			this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			this.sortColumn = column;
			this.sortDirection = 'desc';
		}
		this.filterAndRenderProjects();
		// Update header to show sort indicator
		this.buildContent();
		this.refreshProjects();
	}

	private async refreshProjects(): Promise<void> {
		const recent = await this.recentlyOpened;

		this.projects = recent.workspaces
			.filter((item): item is IRecentFolder | IRecentWorkspace => isRecentFolder(item) || isRecentWorkspace(item))
			.map((item, index) => ({
				...item,
				id: `project-${index}`
			}));

		this.filterAndRenderProjects();
	}

	private filterAndRenderProjects(): void {
		let filtered = [...this.projects];

		// Apply search filter
		if (this.searchQuery) {
			const query = this.searchQuery.toLowerCase();
			filtered = filtered.filter(project => {
				const name = this.getProjectName(project).toLowerCase();
				return name.includes(query);
			});
		}

		// Apply view filter
		if (this.currentView === 'trashed') {
			// For now, we don't have an archived concept, so show empty
			filtered = [];
		}

		// Apply sorting
		filtered.sort((a, b) => {
			let comparison = 0;
			switch (this.sortColumn) {
				case 'title':
					comparison = this.getProjectName(a).localeCompare(this.getProjectName(b));
					break;
				case 'owner':
					// All local projects have the same owner
					comparison = 0;
					break;
				case 'lastModified':
					// We don't have modification time readily available, so sort by order
					comparison = this.projects.indexOf(a) - this.projects.indexOf(b);
					break;
			}
			return this.sortDirection === 'asc' ? comparison : -comparison;
		});

		this.filteredProjects = filtered;

		// Update subtitle with count
		if (this.subtitleElement) {
			this.subtitleElement.textContent = this.getSubtitleText();
		}

		this.renderProjectList();
	}

	private renderProjectList(): void {
		clearNode(this.tableBody);

		if (this.filteredProjects.length === 0) {
			this.renderEmptyState();
			return;
		}

		for (const project of this.filteredProjects) {
			this.renderProjectRow(project);
		}
	}

	private renderEmptyState(): void {
		const emptyRow = this.tableBody.insertRow();
		const emptyCell = emptyRow.insertCell();
		emptyCell.colSpan = 4;

		const emptyState = append(emptyCell, $('.latex-dashboard-empty'));

		const icon = append(emptyState, $('.latex-dashboard-empty-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));

		const title = append(emptyState, $('.latex-dashboard-empty-title'));
		const desc = append(emptyState, $('.latex-dashboard-empty-description'));

		if (this.searchQuery) {
			title.textContent = localize('noSearchResults', 'No projects found');
			desc.textContent = localize('noSearchResultsDesc', 'Try a different search term or create a new project.');
		} else if (this.currentView === 'trashed') {
			title.textContent = localize('noArchivedProjects', 'No archived projects');
			desc.textContent = localize('noArchivedProjectsDesc', 'Archived projects will appear here.');
		} else {
			title.textContent = localize('noProjects', 'No projects yet');
			desc.textContent = localize('noProjectsDesc', 'Create your first LaTeX project to get started with Folio.');

			// Add create button in empty state
			const createBtn = append(emptyState, $('button.latex-dashboard-empty-action'));
			createBtn.textContent = localize('createFirstProject', 'Create Project');
			this.contentDisposables.add(addDisposableListener(createBtn, EventType.CLICK, () => {
				this.createNewProject();
			}));
		}
	}

	private renderProjectRow(project: RecentEntry): void {
		const row = append(this.tableBody, $('tr.project-row'));
		row.tabIndex = 0;

		// Title cell
		const titleCell = append(row, $('td'));
		const titleContainer = append(titleCell, $('.latex-project-title'));

		const folderIcon = append(titleContainer, $('span.latex-project-icon'));
		folderIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));

		const titleText = append(titleContainer, $('span.latex-project-title-text'));
		titleText.textContent = this.getProjectName(project);

		// Owner cell
		const ownerCell = append(row, $('td'));
		const ownerBadge = append(ownerCell, $('span.latex-owner-badge'));
		ownerBadge.textContent = localize('you', 'You');

		// Last modified cell
		const modifiedCell = append(row, $('td'));
		const modifiedText = append(modifiedCell, $('span.latex-modified-time'));
		modifiedText.textContent = localize('recently', 'Recently');

		// Actions cell
		const actionsCell = append(row, $('td'));
		const actions = append(actionsCell, $('.latex-project-actions'));

		// Open action
		const openBtn = append(actions, $('button.latex-project-action'));
		const openIcon = append(openBtn, $('span'));
		openIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.folderOpened));
		append(openBtn, document.createTextNode(localize('open', 'Open')));

		this.contentDisposables.add(addDisposableListener(openBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this.openProject(project);
		}));

		// Copy path action
		const copyBtn = append(actions, $('button.latex-project-action'));
		const copyIcon = append(copyBtn, $('span'));
		copyIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.copy));

		this.contentDisposables.add(addDisposableListener(copyBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this.copyProjectPath(project);
		}));

		// Remove action
		const removeBtn = append(actions, $('button.latex-project-action.delete'));
		const removeIcon = append(removeBtn, $('span'));
		removeIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));

		this.contentDisposables.add(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this.removeFromRecent(project);
		}));

		// Row click opens project
		this.contentDisposables.add(addDisposableListener(row, EventType.CLICK, () => {
			this.openProject(project);
		}));

		// Keyboard navigation
		this.contentDisposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.openProject(project);
			}
		}));
	}

	private getProjectName(project: RecentEntry): string {
		if (project.label) {
			return project.label;
		}
		const uri = this.getProjectUri(project);
		return this.labelService.getUriBasenameLabel(uri);
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

	private async copyProjectPath(project: RecentEntry): Promise<void> {
		const uri = this.getProjectUri(project);
		const path = this.labelService.getUriLabel(uri, { noPrefix: true });
		await navigator.clipboard.writeText(path);
	}

	private async removeFromRecent(project: RecentEntry): Promise<void> {
		const uri = this.getProjectUri(project);
		await this.workspacesService.removeRecentlyOpened([uri]);
	}

	private async createNewProject(): Promise<void> {
		// Get the default projects folder (~/Folio Projects)
		const homeDir = this.environmentService.userHome;
		const projectsBaseUri = URI.joinPath(homeDir, 'Folio Projects');

		// Ensure the base projects folder exists
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

		// Ask for project name
		const projectName = await this.quickInputService.input({
			prompt: localize('projectNamePrompt', 'Enter a name for your new project'),
			placeHolder: localize('projectNamePlaceholder', 'My Project'),
			validateInput: async (value) => {
				if (!value || value.trim().length === 0) {
					return localize('projectNameRequired', 'Project name is required');
				}
				// Check for invalid characters
				if (/[<>:"/\\|?*]/.test(value)) {
					return localize('projectNameInvalid', 'Project name contains invalid characters');
				}
				// Check if project already exists
				const projectUri = URI.joinPath(projectsBaseUri, value.trim());
				const exists = await this.fileService.exists(projectUri);
				if (exists) {
					return localize('projectNameExists', 'A project with this name already exists');
				}
				return null;
			}
		});

		if (!projectName) {
			return; // User cancelled
		}

		const projectUri = URI.joinPath(projectsBaseUri, projectName.trim());

		// Create the project folder and template files
		try {
			await this.fileService.createFolder(projectUri);

			// Create main.tex with template
			const mainTexContent = this.getLatexTemplate(projectName.trim());
			const mainTexUri = URI.joinPath(projectUri, 'main.tex');
			await this.fileService.writeFile(mainTexUri, VSBuffer.fromString(mainTexContent));

			// Open the new project folder
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
