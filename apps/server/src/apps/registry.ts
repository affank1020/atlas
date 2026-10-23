import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';

/** Authenticated identity is injected by the trusted MCP transport after OAuth verification,
 * never accepted from Application arguments or HTTP headers. */
export type ApplicationCaller = Readonly<{ kind: 'mcp-oauth'; subject: string; issuer: string }>;

/** Code-defined first-party Applications, optionally associated with a Project.
 * These are not Views, independent servers or executable uploads.
 */
export type ApplicationTool = {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    invoke(input: any, caller?: ApplicationCaller): Promise<unknown> | unknown;
};

export type ApplicationDefinition = {
    type: string;
    slug: string;
    name: string;
    description: string;
    projectId?: string | null;
    tools: ApplicationTool[];
};

export type ApplicationSummary = Pick<ApplicationDefinition, 'type' | 'slug' | 'name' | 'description'> & { projectId: string | null };

export class ApplicationRegistry {
    private readonly applications = new Map<string, ApplicationDefinition>();
    private readonly operations = new Map<string, ApplicationTool>();

    constructor(definitions: ApplicationDefinition[]) {
        for (const application of definitions) {
            const key = `${application.projectId ?? '@standalone'}/${application.slug}`;
            if (this.applications.has(key)) throw new Error(`Duplicate Atlas Application: ${key}`);
            if (!/^[a-z][a-z0-9-]*$/.test(application.slug)) throw new Error(`Invalid Application slug: ${application.slug}`);
            this.applications.set(key, application);
            for (const operation of application.tools) {
                if (this.operations.has(operation.name) || ['list_applications', 'list_all_applications', 'get_application'].includes(operation.name))
                    throw new Error(`Duplicate Atlas Application operation: ${operation.name}`);
                this.operations.set(operation.name, operation);
            }
        }
    }

    private summary(app: ApplicationDefinition): ApplicationSummary {
        const { type, slug, name, description } = app;
        return { type, slug, name, description, projectId: app.projectId ?? null };
    }

    list(projectId: string): ApplicationSummary[] {
        return this.listAll().filter(app => app.projectId === projectId);
    }

    listAll(): ApplicationSummary[] {
        return [...this.applications.values()].map(app => this.summary(app));
    }

    get(projectId: string | null, slug: string): ApplicationSummary {
        const app = this.applications.get(`${projectId ?? '@standalone'}/${slug}`);
        if (!app) throw new AtlasError('Application not found.', 'NOT_FOUND');
        return this.summary(app);
    }

    tools(): Pick<ApplicationTool, 'name' | 'description' | 'inputSchema'>[] {
        return [...this.operations.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    }

    hasTool(name: string): boolean { return this.operations.has(name); }

    async invoke(name: string, input: unknown, caller?: ApplicationCaller): Promise<unknown> {
        const operation = this.operations.get(name);
        if (!operation) throw new AtlasError('Unknown Application operation.', 'NOT_FOUND');
        return operation.invoke(z.object(operation.inputSchema).parse(input), caller);
    }
}
