import type { AuditService } from "../core/audit.js";
import type { MonitoringActivityQuery } from "../core/repository.js";
/** Both monitoring and legacy activity are projections of the same audit history. */
export class ActivityService {
    constructor(private readonly audit: AuditService) {}
    recent(input: Parameters<AuditService['history']>[0]) { return this.audit.history(input); }
    page(input: MonitoringActivityQuery) { return this.audit.monitoring(input); }
}
