/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/latexProjectsDashboard.css';
import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { IUntypedEditorInput } from '../../../common/editor.js';

export const latexProjectsDashboardInputTypeId = 'workbench.editors.folioProjectsDashboardInput';

export class LatexProjectsDashboardInput extends EditorInput {

	static readonly ID = latexProjectsDashboardInputTypeId;
	static readonly RESOURCE = URI.from({ scheme: Schemas.walkThrough, authority: 'folio_projects_dashboard' });

	override get typeId(): string {
		return LatexProjectsDashboardInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: LatexProjectsDashboardInput.RESOURCE,
			options: {
				override: LatexProjectsDashboardInput.ID,
				pinned: true
			}
		};
	}

	get resource(): URI | undefined {
		return LatexProjectsDashboardInput.RESOURCE;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof LatexProjectsDashboardInput;
	}

	constructor() {
		super();
	}

	override getName() {
		return localize('folio', "Folio");
	}
}
