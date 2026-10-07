import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { devTasksSchema } from '@atlas/protocol/dev-tasks';
export async function readDevTasks(file) {
    return devTasksSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}
/** Local administrator only. No HTTP/MCP mutation route exists for executable argv. */
export async function configureDevTasks(pool, workspaceId, tasks) {
    const configured = devTasksSchema.parse(tasks);
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        const previous = await db.query(`SELECT w.id,w.project_id,w.dev_tasks FROM workspaces w JOIN projects p ON p.id=w.project_id
            WHERE w.id=$1 AND w.archived_at IS NULL AND p.archived_at IS NULL FOR UPDATE OF w`, [workspaceId]);
        if (!previous.rowCount) throw new Error('Active Workspace not found.');
        const row = previous.rows[0];
        await db.query('UPDATE workspaces SET dev_tasks=$2,updated_at=now() WHERE id=$1', [workspaceId, configured]);
        await db.query(`INSERT INTO audit_events(id,client,operation,project_id,workspace_id,before_state,after_state,created_at)
            VALUES($1,'atlas-local-admin','workspace.dev_tasks_configured',$2,$3,$4,$5,now())`,
            [randomUUID(), row.project_id, workspaceId, { tasks: Object.keys(row.dev_tasks) }, { tasks: Object.keys(configured) }]);
        await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { db.release(); }
}
