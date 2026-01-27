/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { MenuId, registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { LatexProjectsDashboardInput } from './latexProjectsDashboardInput.js';
import { LatexProjectsDashboard } from './latexProjectsDashboard.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorSerializer } from '../../../common/editor.js';

// Register the action to open Folio Dashboard
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openFolioDashboard',
			title: localize2('folio', 'Folio'),
			category: Categories.View,
			f1: true,
			menu: {
				id: MenuId.MenubarFileMenu,
				group: '1_new',
				order: 5,
			},
		});
	}

	public run(accessor: ServicesAccessor) {
		const editorService = accessor.get(IEditorService);
		editorService.openEditor({
			resource: LatexProjectsDashboardInput.RESOURCE,
			options: { pinned: true }
		});
	}
});

// Register editor serializer for the input
class FolioInputSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof LatexProjectsDashboardInput;
	}

	serialize(editorInput: EditorInput): string | undefined {
		if (editorInput instanceof LatexProjectsDashboardInput) {
			return JSON.stringify({});
		}
		return undefined;
	}

	deserialize(instantiationService: IInstantiationService): EditorInput | undefined {
		return instantiationService.createInstance(LatexProjectsDashboardInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	LatexProjectsDashboardInput.ID,
	FolioInputSerializer
);

// Register the editor pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		LatexProjectsDashboard,
		LatexProjectsDashboard.ID,
		localize('folio', 'Folio')
	),
	[
		new SyncDescriptor(LatexProjectsDashboardInput)
	]
);

// Editor resolver for the walkthrough scheme
class FolioEditorResolverContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.folioEditorResolver';

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorResolverService editorResolverService: IEditorResolverService
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${LatexProjectsDashboardInput.RESOURCE.scheme}://${LatexProjectsDashboardInput.RESOURCE.authority}/**`,
			{
				id: LatexProjectsDashboardInput.ID,
				label: localize('folio.displayName', 'Folio'),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: uri =>
					uri.scheme === LatexProjectsDashboardInput.RESOURCE.scheme &&
					uri.authority === LatexProjectsDashboardInput.RESOURCE.authority,
			},
			{
				createEditorInput: () => {
					return {
						editor: this.instantiationService.createInstance(LatexProjectsDashboardInput),
						options: { pinned: true }
					};
				}
			}
		));
	}
}

// Main contribution that controls showing/hiding parts
class FolioRunnerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.folioRunner';

	private dashboardActive = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		this.run();

		// Listen for workspace state changes
		this._register(this.contextService.onDidChangeWorkbenchState(() => {
			this.handleWorkspaceStateChange();
		}));

		// Listen for editor changes
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.handleEditorChange();
		}));

		// Listen for editor close - reopen dashboard if closed in empty workspace
		this._register(this.editorService.onDidCloseEditor((e) => {
			if (e.editor instanceof LatexProjectsDashboardInput) {
				this.handleDashboardClosed();
			}
		}));
	}

	private async run(): Promise<void> {
		// Wait for lifecycle phase
		await this.lifecycleService.when(LifecyclePhase.Restored);

		// Check if Folio dashboard is the configured startup editor
		const startupEditor = this.configurationService.getValue<string>('workbench.startupEditor');
		if (startupEditor !== 'latexProjectsDashboard') {
			return;
		}

		// Check if we're in an empty workspace
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			await this.showDashboard();
		}
	}

	private async showDashboard(): Promise<void> {
		this.dashboardActive = true;

		// Hide all workbench parts for a clean UI
		this.hideAllParts();

		// Open the dashboard editor
		const input = this.instantiationService.createInstance(LatexProjectsDashboardInput);
		await this.editorService.openEditor(input, { pinned: true });

		// Ensure parts stay hidden after editor opens
		setTimeout(() => {
			if (this.dashboardActive) {
				this.hideAllParts();
			}
		}, 100);
	}

	private hideAllParts(): void {
		this.layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
		this.layoutService.setPartHidden(true, Parts.STATUSBAR_PART);
	}

	private restoreUI(): void {
		if (!this.dashboardActive) {
			return;
		}

		this.dashboardActive = false;

		// Restore workbench parts
		this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
		this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
		this.layoutService.setPartHidden(false, Parts.STATUSBAR_PART);
		// Panel and auxiliary bar stay hidden by default
	}

	private handleWorkspaceStateChange(): void {
		// If a workspace is now open, restore the UI
		if (this.contextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			this.restoreUI();
		} else {
			// If workspace becomes empty again, show dashboard
			const startupEditor = this.configurationService.getValue<string>('workbench.startupEditor');
			if (startupEditor === 'latexProjectsDashboard') {
				this.showDashboard();
			}
		}
	}

	private handleEditorChange(): void {
		const activeEditor = this.editorService.activeEditor;

		if (activeEditor instanceof LatexProjectsDashboardInput) {
			// Dashboard is active - ensure parts are hidden
			if (!this.dashboardActive) {
				this.dashboardActive = true;
				this.hideAllParts();
			}
		} else if (activeEditor) {
			// Different editor is active - restore UI
			this.restoreUI();
		}
	}

	private handleDashboardClosed(): void {
		// If we're still in empty workspace and dashboard was closed, reopen it
		if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			const startupEditor = this.configurationService.getValue<string>('workbench.startupEditor');
			if (startupEditor === 'latexProjectsDashboard') {
				// Small delay to prevent rapid open/close cycles
				setTimeout(() => {
					if (this.contextService.getWorkbenchState() === WorkbenchState.EMPTY) {
						this.showDashboard();
					}
				}, 50);
			}
		}
	}
}

registerWorkbenchContribution2(
	FolioEditorResolverContribution.ID,
	FolioEditorResolverContribution,
	WorkbenchPhase.BlockRestore
);

registerWorkbenchContribution2(
	FolioRunnerContribution.ID,
	FolioRunnerContribution,
	WorkbenchPhase.AfterRestored
);
