import type { AuditService } from "../core/audit.js";
import type { MonitoringActivityQuery } from "../core/repository.js";
import { projectMonitoringEvent } from "./safe-detail.js";
/** Both monitoring and legacy activity are projections of the same audit history. */
export class ActivityService {
    constructor(private readonly audit: AuditService) {}
    recent(input: Parameters<AuditService['history']>[0]) { return this.audit.history(input); }
    async page(input: MonitoringActivityQuery) {
        const page = await this.audit.monitoring(input);
        return input.safeDetails ? { ...page, items: page.items.map(projectMonitoringEvent) } : page;
    }
}
