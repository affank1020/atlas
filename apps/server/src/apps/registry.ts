import { z } from 'zod';
import { AtlasError } from '../shared/errors.js';

/**
 * Code-defined first-party Applications. An Application belongs to an existing
 * Project; it is not a View, an independent server or an executable upload.
 */
export type ApplicationTool = {
    name: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    invoke(input: any): Promise<unknown> | unknown;
};

export type ApplicationDefinition = {
    type: string;
    slug: string;
    name: string;
    description: string;
    projectId: string;
    tools: ApplicationTool[];
};

export type ApplicationSummary = Pick<ApplicationDefinition, 'type' | 'slug' | 'name' | 'description' | 'projectId'>;

export class ApplicationRegistry {
    private readonly applications = new Map<string, ApplicationDefinition>();
    private readonly operations = new Map<string, ApplicationTool>();

    constructor(definitions: ApplicationDefinition[]) {
        for (const application of definitions) {
            const key = `${application.projectId}/${application.slug}`;
            if (this.applications.has(key)) throw new Error(`Duplicate Atlas Application: ${key}`);
            if (!/^[a-z][a-z0-9-]*$/.test(application.slug)) throw new Error(`Invalid Application slug: ${application.slug}`);
            this.applications.set(key, application);
            for (const operation of application.tools) {
                if (this.operations.has(operation.name) || operation.name === 'list_applications' || operation.name === 'get_application')
                    throw new Error(`Duplicate Atlas Application operation: ${operation.name}`);
                this.operations.set(operation.name, operation);
            }
        }
    }

    list(projectId: string): ApplicationSummary[] {
        return [...this.applications.values()]
            .filter(app => app.projectId === projectId)
            .map(({ type, slug, name, description, projectId }) => ({ type, slug, name, description, projectId }));
    }

    get(projectId: string, slug: string): ApplicationSummary {
        const app = this.applications.get(`${projectId}/${slug}`);
        if (!app) throw new AtlasError('Application not found in this project.', 'NOT_FOUND');
        const { type, name, description } = app;
        return { type, slug, name, description, projectId };
    }

    tools(): Pick<ApplicationTool, 'name' | 'description' | 'inputSchema'>[] {
        return [...this.operations.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    }

    hasTool(name: string): boolean { return this.operations.has(name); }

    async invoke(name: string, input: unknown): Promise<unknown> {
        const operation = this.operations.get(name);
        if (!operation) throw new AtlasError('Unknown Application operation.', 'NOT_FOUND');
        return operation.invoke(z.object(operation.inputSchema).parse(input));
    }
}
