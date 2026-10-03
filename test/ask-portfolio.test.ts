import assert from "node:assert/strict";
import test, { after } from "node:test";
import { signRequest } from "@contentful/node-apps-toolkit";
import { AskPortfolioService } from "../src/apps/ask-portfolio/index.js";
import { createFabric } from "../src/fabric/index.js";
import { ContentfulPortfolioIntegration, PORTFOLIO_PROJECT_ID, verifyContentfulWebhook } from "../src/integrations/contentful.js";
import { cleanupDatabases, databaseFixture } from "./database.js";

after(cleanupDatabases);

test("Ask Portfolio always replaces caller scope and bypasses Core-aware planning", async () => {
    const calls: unknown[] = [];
    const service = new AskPortfolioService({ ask: async input => { calls.push(input); return { question: input.question, answer: "ok", sources: [], diagnostics: {} } as never; } });
    await service.ask({ question: "Tell me everything", projectIds: ["11111111-1111-4111-8111-111111111111"], retrievalMode: "planned" });
    assert.deepEqual(calls, [{ question: "Tell me everything", projectIds: [PORTFOLIO_PROJECT_ID], retrievalMode: "direct" }]);
});

test("Contentful signing headers are verified against the untouched request body", () => {
    const secret = "a".repeat(64), path = "/integrations/contentful/webhook", body = JSON.stringify({ sys: { id: "entry-1" } });
    const signed = signRequest(secret, { method: "POST", path, body });
    const request = { url: path, headers: signed } as never;
    assert.equal(verifyContentfulWebhook(request, body, secret, 0), true);
    assert.equal(verifyContentfulWebhook(request, `${body} `, secret, 0), false);
});

test("full Contentful sync reconciles derived Fabric rows without creating Core data", async () => {
    const fixture = await databaseFixture();
    const fabric = createFabric(fixture.databaseUrl, null);
    let revision = 1;
    const fetcher = async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        const isEntries = url.pathname.endsWith("/entries");
        const project = { sys: { id: "project-1", type: "Entry", createdAt: "2026-01-01T00:00:00Z", updatedAt: `2026-01-0${revision}T00:00:00Z`, contentType: { sys: { id: "project" } } }, fields: { title: "Atlas", summary: revision === 1 ? "First version" : "Updated version" } };
        const blog = { sys: { id: "blog-1", type: "Entry", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", contentType: { sys: { id: "blogPost" } } }, fields: { title: "Sourdough Quasar" } };
        const pdf = { sys: { id: "cv-1", type: "Asset", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, fields: { title: "CV", file: { contentType: "application/pdf", fileName: "cv.pdf", url: "//assets.ctfassets.net/cv.pdf" } } };
        const image = { sys: { id: "hero-1", type: "Asset", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, fields: { title: "Hero", file: { contentType: "image/png", fileName: "hero.png" } } };
        const items = isEntries ? (revision === 1 ? [project, blog] : [project]) : [pdf, image];
        return new Response(JSON.stringify({ total: items.length, skip: 0, limit: 1000, items }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const integration = new ContentfulPortfolioIntegration(fabric.repository, { CONTENTFUL_SPACE_ID: "space", CONTENTFUL_DELIVERY_ACCESS_TOKEN: "token", CONTENTFUL_ENVIRONMENT: "master" }, fetcher as typeof fetch);
    const first = await integration.syncPortfolio("manual");
    assert.deepEqual(first.counts, { total: 3, projects: 1, blogs: 1, experience: 0, documents: 1 });
    assert.equal((await fixture.catalog.listProjects()).length, 0);
    assert.equal((await fabric.search.search({ query: "First version", projectIds: [PORTFOLIO_PROJECT_ID], mode: "lexical" })).results.length, 1);
    revision = 2;
    const second = await integration.syncPortfolio("manual");
    assert.deepEqual(second.counts, { total: 2, projects: 1, blogs: 0, experience: 0, documents: 1 });
    assert.equal((await fabric.search.search({ query: "Sourdough", projectIds: [PORTFOLIO_PROJECT_ID], mode: "lexical" })).results.length, 0);
    assert.equal((await fabric.search.search({ query: "Updated version", projectIds: [PORTFOLIO_PROJECT_ID], mode: "lexical" })).results.length, 1);
    await fabric.repository.close();
});
