/** Compatibility facade for existing callers. New services depend on CoreService or ViewService. */
import { CoreService } from "./core/service.js";
import { ViewService } from "./views/service.js";
export { AtlasError } from "./shared/errors.js";
export class AtlasCatalog extends CoreService {
    readonly views = new ViewService(this);
    listViews(...args: Parameters<ViewService["listViews"]>) { return this.views.listViews(...args); }
    getView(...args: Parameters<ViewService["getView"]>) { return this.views.getView(...args); }
    createView(...args: Parameters<ViewService["createView"]>) { return this.views.createView(...args); }
    updateView(...args: Parameters<ViewService["updateView"]>) { return this.views.updateView(...args); }
    archiveView(...args: Parameters<ViewService["archiveView"]>) { return this.views.archiveView(...args); }
    viewHistory(...args: Parameters<ViewService["viewHistory"]>) { return this.views.viewHistory(...args); }
    renderView(...args: Parameters<ViewService["renderView"]>) { return this.views.renderView(...args); }
    previewView(...args: Parameters<ViewService["previewView"]>) { return this.views.previewView(...args); }
    executeViewAction(...args: Parameters<ViewService["executeViewAction"]>) { return this.views.executeViewAction(...args); }
    getViewBySlug(...args: Parameters<ViewService["getViewBySlug"]>) { return this.views.getViewBySlug(...args); }
}
