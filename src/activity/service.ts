import type { AuditService } from "../core/audit.js";
/** The existing recent-activity response is an audit projection, with identical filters. */
export class ActivityService {
    constructor(private readonly audit: AuditService) {}
    recent(input: Parameters<AuditService['history']>[0]) { return this.audit.history(input); }
}
