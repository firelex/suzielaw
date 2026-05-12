import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApprovalQueue, InMemoryApprovalStore } from '@teamsuzie/approvals';
import {
  connectMcpServers,
  loadSkills,
  parseMcpConfigFile,
  resolveAgentTarget,
  runChatTurn,
  tools as builtInTools,
  type AnyToolDefinition,
  type ChatMessage,
  type McpManager,
  type SkillLoadResult,
  type ToolContext,
} from '@teamsuzie/agent-loop';
import { config } from './config.js';
import { createAuthRouter, createSessionMiddleware, getSessionUser, requireAuth } from './auth.js';
import {
    createPlatformRequestMiddleware,
    createWebhookRouter,
    registerWithPlatform,
    runWebhookChatTurn,
    type PlatformBridgeConfig,
} from '@teamsuzie/platform-bridge';
import {
  createCsrfMiddleware,
  createOAuthRouter,
  createTokenMeteredFetch,
  TokenBudgetStore,
  TokenLimitExceededError,
} from '@teamsuzie/hosted-demo';
import {
  buildAttachmentContext,
  buildCitationProtocolBlock,
  createFilesRouter,
  createMatterUploadsRouter,
  InMemoryFileStore,
} from './files.js';
import { InMemoryDocumentStore } from '@teamsuzie/markdown-document';
import { buildDocumentTools } from './document-tools.js';
import { buildLegalResearchTools } from './tools/legal-research/index.js';
import { buildDiffTools } from './tools/diff.js';
import { buildProposeEditsTools } from './tools/propose-edits.js';
import { buildFindInDocumentTools } from './tools/find-in-document.js';
import { buildReplicateDocumentTools } from './tools/replicate-document.js';
import { buildGenerateDocxTools } from './tools/generate-docx.js';
import { applyWorkflowOverrides } from './workflow-overrides.js';
import { buildTemplateTools } from './tools/templates.js';
import { applyPersona, createPersonasRouter, PersonaRegistry } from '@teamsuzie/personas';
import { createKbSearchTool } from '@teamsuzie/kb';
import { createModelSettingsRouter, ModelSettingsStore } from '@teamsuzie/model-settings';
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_IDS, providerForModel, wireModelIdFor } from './cloud-providers.js';
import { createWorkspacesRouter, WorkspacesStore } from '@teamsuzie/workspaces';
import { DocumentVersionsStore } from '@teamsuzie/document-versions';
import { MembersStore } from '@teamsuzie/sharing';
import {
  backfillMatterOwnership,
  createMatterMembersRouter,
  createRequireMatterAccess,
  createWorkflowMembersRouter,
  listVisibleWorkflowsForUser,
  resolveWorkflowRole,
} from './sharing.js';
import { createReviewsRouter, ReviewsStore } from '@teamsuzie/grid-review';
import { buildReviewRunAdapter } from './reviews-glue.js';
import { ChatsStore, createChatsRouter } from '@teamsuzie/chats';
import { WorkflowsStore, createWorkflowsRouter } from '@teamsuzie/workflows';
import { seedAndMigrateWorkflows } from './seed-workflows.js';
import { parseResponse } from '@teamsuzie/citations';
import type { FileRecord } from './files.js';
import { MatterRag } from './matter-rag.js';
import { buildKbStore, createKbRouter } from './kb.js';
import { draftColumnPrompt } from './column-draft.js';
import { buildReviewWorkbook } from './reviews-export.js';
import { runDocumentDiff } from './diff-engine.js';
import { composeRedlineDocx, redlineDownloadFilename } from './redline-export.js';
import { extractRedlineParagraphs } from './redline-view.js';
import { acceptRevision, loadDocx, rejectRevision } from '@teamsuzie/docx';
import { draftChatTitle } from './chat-title.js';
import { db } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDistDir = path.resolve(__dirname, '../client/dist');

const approvals = new ApprovalQueue({ store: new InMemoryApprovalStore() });
const fileStore = new InMemoryFileStore();
const docStore = new InMemoryDocumentStore();
const tokenBudget = new TokenBudgetStore(db, config.tokenBudget.defaultLimit);

let skillState: SkillLoadResult = { skills: [], systemPrompt: '', derivedHosts: [] };
let mcp: McpManager = { tools: [], status: [], shutdown: async () => {} };
let templateTools: AnyToolDefinition[] = [];

const legalResearchTools = buildLegalResearchTools({
  courtListenerToken: config.legalResearch.courtListenerToken,
  courtListenerBaseUrl: config.legalResearch.courtListenerBaseUrl,
  pisteClientId: config.legalResearch.pisteClientId,
  pisteClientSecret: config.legalResearch.pisteClientSecret,
  judilibreApiKey: config.legalResearch.judilibreApiKey,
  indianKanoonApiKey: config.legalResearch.indianKanoonApiKey,
});
if (legalResearchTools.length > 0) {
  console.log(`Legal-research tools enabled: ${legalResearchTools.map((t) => t.name).join(', ')}`);
}

const personaRegistry = new PersonaRegistry({
  filesystemDir: config.personas.dir,
  db,
});
if (personaRegistry.listBuiltins().length > 0) {
  console.log(
    `Loaded ${personaRegistry.listBuiltins().length} builtin persona(s): ${personaRegistry
      .listBuiltins()
      .map((p) => p.id)
      .join(', ')}`,
  );
}

// Per-user model-endpoint overrides (the editable config behind each Local row).
const modelSettings = new ModelSettingsStore({ db, envRegistry: config.modelAgents });

// Workspaces (legal apps surface them as "Matters") — schema lives upstream;
// the suzielaw API mounts this at /api/matters to match the UI label.
const workspaces = new WorkspacesStore({ db });

// Document version chains. Every matter-doc upload records a
// `source: 'upload'` version; chat-driven proposals branch from that
// with `source: 'proposal'`. No HTTP surface yet — host code reads it
// via the store directly.
const documentVersions = new DocumentVersionsStore({ db });

// Cross-subject membership store. Ownership of matters is encoded as
// an owner-role member row added at matter-creation time (see the POST
// /api/matters shadow below). Existing pre-membership matters are
// backfilled to the demo user at boot — single-user demo bridge.
const members = new MembersStore({ db });
{
  const { granted } = backfillMatterOwnership({
    members,
    workspaces,
    ownerEmail: config.demo.email,
  });
  if (granted > 0) {
    console.log(`Sharing: backfilled ${granted} matter(s) with owner=${config.demo.email}`);
  }
}
const requireMatterAccess = createRequireMatterAccess({ members, workspaces });

// Tabular reviews. Mounted under /api/matters/:matterId/reviews.
const reviews = new ReviewsStore({ db });
{
  const recovered = reviews.recoverStaleStreaming();
  if (recovered > 0) {
    console.log(`Reviews: reset ${recovered} stale streaming cell(s) to pending after restart.`);
  }
}

// Persisted matter-scoped chats. Mounted under /api/matters/:matterId/chats.
const chats = new ChatsStore({ db });

// Workflows-as-data. System workflows seed at startup from code-defined
// catalogs; user workflows are created via UI.
const workflows = new WorkflowsStore({ db });
seedAndMigrateWorkflows(workflows, db);

// Knowledge base — sqlite-vec backed RAG. Always available now: matter
// docs are indexed into it for cell runs (and later matter chats),
// regardless of the user-facing KB feature flag. The flag below only
// controls whether to expose the user-facing KB router + the
// `vector_search` chat tool.
const kbStore = buildKbStore();
{
  const stats = kbStore.count(null);
  console.log(
    `Knowledge base store ready: ${stats.documents} document(s), ${stats.chunks} chunk(s); embeddings via ${config.kb.embeddingModel} (dim ${config.kb.embeddingDim}) at ${config.kb.embeddingBaseUrl}`,
  );
}
const kbSearchTool = config.kb.enabled
  ? createKbSearchTool({ store: kbStore })
  : null;

// Per-matter RAG glue: indexes uploaded matter docs into kbStore (with
// owner_id = matter:<matterId>) and exposes per-doc + per-matter search.
const matterRag = new MatterRag({
  db,
  kb: kbStore,
  markitdownBaseUrl: config.markitdown.baseUrl,
});

function activeTools(): AnyToolDefinition[] {
  const out: AnyToolDefinition[] = [...builtInTools, ...legalResearchTools, ...templateTools, ...mcp.tools];
  if (kbSearchTool) out.push(kbSearchTool as unknown as AnyToolDefinition);
  return out;
}

async function bootstrapTemplates(): Promise<void> {
  try {
    templateTools = await buildTemplateTools({ templatesDir: config.templates.dir });
  } catch (error) {
    console.error('Template load failed:', error instanceof Error ? error.message : error);
  }
}

async function bootstrapMcp(): Promise<void> {
  if (!config.mcp.configPath) return;
  try {
    const servers = parseMcpConfigFile(config.mcp.configPath);
    if (servers.length === 0) return;
    mcp = await connectMcpServers({ servers });
    for (const status of mcp.status) {
      if (status.connected) {
        console.log(`MCP server "${status.name}" connected (${status.toolCount} tool(s))`);
      } else {
        console.warn(`MCP server "${status.name}" failed: ${status.error ?? 'unknown error'}`);
      }
    }
  } catch (error) {
    console.error('MCP bootstrap failed:', error instanceof Error ? error.message : error);
  }
}

async function bootstrapSkills(): Promise<void> {
  if (!config.skills.skillsDir && !config.skills.catalogUrl) return;
  try {
    skillState = await loadSkills({
      skillsDir: config.skills.skillsDir,
      catalogUrl: config.skills.catalogUrl,
      catalogToken: config.skills.catalogToken,
      allow: config.skills.allow.length ? config.skills.allow : undefined,
      renderContext: config.skills.renderContext,
    });
    if (skillState.skills.length > 0) {
      console.log(
        `Loaded ${skillState.skills.length} skill(s): ${skillState.skills
          .map((s) => `${s.skillName} (${s.sourceId})`)
          .join(', ')}`,
      );
    }
  } catch (error) {
    console.error('Skill load failed:', error instanceof Error ? error.message : error);
  }
}

let toolCtx: ToolContext = {
  approvals,
  vectorDbBaseUrl: config.vectorDb.baseUrl,
  vectorDbApiKey: config.vectorDb.apiKey,
  allowedHttpHosts: [...config.tools.allowedHttpHosts],
};

function rebuildToolCtx(): void {
  const hosts = [...new Set([...config.tools.allowedHttpHosts, ...skillState.derivedHosts])];
  toolCtx = {
    approvals,
    vectorDbBaseUrl: config.vectorDb.baseUrl,
    vectorDbApiKey: config.vectorDb.apiKey,
    allowedHttpHosts: hosts,
  };
}

const app = express();
app.use(cors({ origin: config.allowedOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(createSessionMiddleware());
app.use(createCsrfMiddleware({
    cookieName: 'suzielaw.csrf',
    // Mothership webhooks authenticate via X-Platform-Token (handled by
    // createPlatformTokenGuard inside the router) — they have no CSRF cookie
    // because they're server-to-server, not browser-driven.
    skipPaths: ['/api/webhook/mothership', '/api/webhook/mothership/'],
}));
app.use('/api', createAuthRouter({ budget: tokenBudget }));
app.use(
  '/api',
  createOAuthRouter({
    providers: config.oauth.providers,
    budget: tokenBudget,
    defaultRole: 'attorney',
  }),
);
// /api/user-prompts is gone — replaced by /api/workflows. Existing
// rows are migrated into the workflows table at boot via
// `seedAndMigrateWorkflows`; the legacy `user_prompts` table stays
// for now as the migration source and gets dropped in a future
// migration.
app.use(
  '/api/personas',
  requireAuth,
  // Seed-on-first-login: every authenticated user gets an editable copy
  // of the file-based built-ins on their first /api/personas hit. The
  // call is idempotent — once seeded, it's a single SELECT against the
  // `personas_seeded` marker table.
  (req, _res, next) => {
    const email = getSessionUser(req)?.email;
    if (email) personaRegistry.seedFromBuiltinsIfNeeded(email);
    next();
  },
  createPersonasRouter({
    registry: personaRegistry,
    getOwnerId: (req) => getSessionUser(req)?.email,
  }),
);
app.use(
  '/api/model-settings',
  requireAuth,
  createModelSettingsRouter({
    store: modelSettings,
    getOwnerId: (req) => getSessionUser(req)?.email,
    providerIds: CLOUD_PROVIDER_IDS,
  }),
);
// Shadow POST /api/matters so we can grant the creator owner role in
// the same call. The workspaces router's POST has no hook for this,
// and we don't want to add one upstream until/unless multi-tenant
// production needs it. Registered before the workspaces router so it
// matches first.
app.post('/api/matters', requireAuth, (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const name = String(body?.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const descriptionInput = body?.description;
  const description =
    typeof descriptionInput === 'string' ? descriptionInput.trim() : '';
  const created = workspaces.createWorkspace({
    name,
    description: description.length > 0 ? description : null,
  });
  members.addMember({
    subjectType: 'matter',
    subjectId: created.id,
    userId,
    role: 'owner',
    grantedBy: userId,
  });
  res.status(201).json({ item: created });
});

// Shadow GET /api/matters to filter by membership. The workspaces
// router still serves PATCH/archive/delete/etc.; those nested routes
// run through the requireMatterAccess middleware mounted just below.
app.get('/api/matters', requireAuth, (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const includeArchived = req.query.archived === 'true';
  const accessible = workspaces
    .listWorkspaces({ includeArchived })
    .filter(
      (w) =>
        members.getRole({ type: 'matter', id: w.id }, userId) !== null,
    );
  res.json({ items: accessible });
});

// Gate every matter-scoped subroute on membership. Mounted before
// the workspaces router and the chats / reviews / files / diff routers
// so they all inherit the access check. Bare /api/matters (list +
// create) is shadowed above and not affected by this middleware.
app.use(
  '/api/matters/:matterId',
  requireAuth,
  requireMatterAccess,
);

app.use(
  '/api/matters/:matterId/members',
  requireAuth,
  createMatterMembersRouter({ members, workspaces }),
);

app.use(
  '/api/matters',
  requireAuth,
  createWorkspacesRouter({
    store: workspaces,
    onDocumentRemoved: (workspace, doc) => {
      // Cascade: KB index → file bytes → any review rows that pointed at
      // this file. Without the last two steps, re-uploading the same file
      // produces a new file_id and orphans the original — leaving stale
      // review_documents rows whose lookups fall through to the legacy
      // "Indexing not ready" full-doc path.
      matterRag.removeFile(workspace.id, doc.externalDocId);
      const filesRemoved = fileStore.delete(workspace.id, doc.externalDocId);
      const reviewRowsRemoved = reviews.removeDocumentsByExternalId(
        workspace.id,
        doc.externalDocId,
      );
      if (filesRemoved || reviewRowsRemoved > 0) {
        console.log(
          `[matter] cleaned up ${doc.name}: ${filesRemoved ? 'file bytes,' : ''} ${reviewRowsRemoved} review row(s)`,
        );
      }
    },
    onWorkspaceRemoved: (workspaceId) => {
      matterRag.removeMatter(workspaceId);
      members.removeMembersFor({ type: 'matter', id: workspaceId });
    },
  }),
);
app.use(
  '/api/matters',
  requireAuth,
  createMatterUploadsRouter({
    fileStore,
    workspaces,
    maxUploadBytes: config.files.maxUploadBytes,
    rag: matterRag,
    documentVersions,
  }),
);
const reviewRunAdapter = buildReviewRunAdapter({
  fileStore,
  rag: matterRag,
  markitdownBaseUrl: config.markitdown.baseUrl,
  agentBaseUrl: config.agent.baseUrl,
  agentApiKey: config.agent.apiKey,
  // Cells run against the lighter model — focused single-doc Q&A on
  // retrieved chunks doesn't need the heavyweight chat model.
  model: config.agent.simpleModel,
  // HyDE rewrite is a one-sentence completion; always run it on the
  // cheap model regardless of which chat model the user picked.
  hydeModel: config.agent.simpleModel,
  // Provider knobs (e.g. Qwen's enable_thinking:false) — without these
  // every cell-run + HyDE rewrite triggers Qwen3's thinking phase and
  // takes 20s+. The chat endpoint already passes this; cells need it too.
  extraBody: config.agent.extraBody,
  tokenBudget,
  fallbackTokensPerCall: config.tokenBudget.fallbackTokensPerCall,
});
app.use(
  '/api/matters/:matterId/chats',
  requireAuth,
  (req, _res, next) => {
    (req as unknown as { _matterId?: string })._matterId = String(
      req.params.matterId ?? '',
    );
    next();
  },
  createChatsRouter({
    store: chats,
    getWorkspaceId: (req) =>
      (req as unknown as { _matterId?: string })._matterId ?? '',
  }),
);
// Workflows library. Visibility scopes by the session user — system
// rows are shared, user rows are per-account, plus workflows shared
// explicitly via member rows.
//
// Custom GET / and GET /:id shadow the upstream router so explicitly-shared
// workflows are visible. Mount the members router before the upstream router
// so its routes match first.
app.get('/api/workflows', requireAuth, (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const includeArchived = req.query.includeArchived === '1';
  res.json({
    items: listVisibleWorkflowsForUser({
      workflows,
      members,
      ownerId: userId,
      includeArchived,
    }),
  });
});
app.get('/api/workflows/:id', requireAuth, (req, res) => {
  const userId = getSessionUser(req)?.email;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const id = String(req.params.id ?? '');
  const role = resolveWorkflowRole({
    workflows,
    members,
    workflowId: id,
    userId,
  });
  if (!role) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ item: workflows.get(id), role });
});
app.use(
  '/api/workflows/:workflowId/members',
  requireAuth,
  createWorkflowMembersRouter({ members, workflows }),
);
app.use(
  '/api/workflows',
  requireAuth,
  createWorkflowsRouter({
    store: workflows,
    getOwnerId: (req) => getSessionUser(req)?.email,
  }),
);
// Review-scoped chats live in the same chats table, namespaced by a
// `review:<reviewId>` workspace_id prefix. The chats package treats the
// workspace_id as opaque so this slots in with no upstream changes —
// the matter-scoped chats list filters by `<matterId>` and won't see
// these rows. /api/chat below detects the prefix and attaches the
// review's documents instead of the whole matter's.
app.use(
  '/api/matters/:matterId/reviews/:reviewId/chats',
  requireAuth,
  (req, _res, next) => {
    const reviewId = String(req.params.reviewId ?? '');
    (req as unknown as { _reviewWorkspaceId?: string })._reviewWorkspaceId =
      reviewId ? `review:${reviewId}` : '';
    next();
  },
  createChatsRouter({
    store: chats,
    getWorkspaceId: (req) =>
      (req as unknown as { _reviewWorkspaceId?: string })._reviewWorkspaceId ?? '',
  }),
);
// Top-level Assistant chats — namespaced by an `assistant:<userEmail>` workspace_id
// prefix. Same chats table; per-user scoping keeps each demo user's history
// separate. /api/chat below detects the prefix and treats the chat as standalone
// (no auto-attach of matter/review documents).
app.use(
  '/api/assistant/chats',
  requireAuth,
  createChatsRouter({
    store: chats,
    getWorkspaceId: (req) => {
      const email = getSessionUser(req)?.email;
      return email ? `assistant:${email}` : '';
    },
  }),
);
app.use(
  '/api/matters/:matterId/reviews',
  requireAuth,
  (req, _res, next) => {
    // Express 5 doesn't merge parent params into a sub-router by default —
    // stash matterId where the reviews router can find it.
    (req as unknown as { _matterId?: string })._matterId = String(
      req.params.matterId ?? '',
    );
    next();
  },
  createReviewsRouter({
    store: reviews,
    getWorkspaceId: (req) =>
      (req as unknown as { _matterId?: string })._matterId ?? '',
    runAdapter: reviewRunAdapter,
  }),
);
// Files are user content — gate behind auth before mounting the router.
app.use('/api/files', requireAuth);

// Redline preview + accept/reject by revision id. Operates on proposal
// DOCX bytes living in the file store; both routes mutate or read by
// `:sessionId/:fileId`. Mounted before the generic files router so the
// more specific paths match first.
app.get('/api/files/:sessionId/:fileId/redline-view', requireAuth, (req, res) => {
  const sessionId = String(req.params.sessionId ?? '');
  const fileId = String(req.params.fileId ?? '');
  const rec = fileStore.get(sessionId, fileId);
  if (!rec) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (
    !rec.name.toLowerCase().endsWith('.docx') &&
    rec.mimeType !==
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    res.status(400).json({ error: 'redline_view requires a .docx file' });
    return;
  }
  try {
    const paragraphs = extractRedlineParagraphs(rec.bytes);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ paragraphs });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'extract failed' });
  }
});

app.post(
  '/api/files/:sessionId/:fileId/revisions/resolve',
  requireAuth,
  (req, res) => {
    const sessionId = String(req.params.sessionId ?? '');
    const fileId = String(req.params.fileId ?? '');
    const rec = fileStore.get(sessionId, fileId);
    if (!rec) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (
      !rec.name.toLowerCase().endsWith('.docx') &&
      rec.mimeType !==
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      res.status(400).json({ error: 'resolve requires a .docx file' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const accept = Array.isArray(body?.accept)
      ? (body!.accept as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];
    const reject = Array.isArray(body?.reject)
      ? (body!.reject as unknown[])
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];
    if (accept.length === 0 && reject.length === 0) {
      res.status(400).json({ error: 'accept or reject must be non-empty' });
      return;
    }
    try {
      const file = loadDocx(rec.bytes);
      let changed = 0;
      for (const id of accept) if (acceptRevision(file, id)) changed++;
      for (const id of reject) if (rejectRevision(file, id)) changed++;
      const newBytes = file.save();
      // Mutate in place — same fileId, same bucket. The download_url
      // returned by the original tool call stays valid; the bytes behind
      // it are now the post-resolution version.
      fileStore.put({
        ...rec,
        bytes: newBytes,
        size: newBytes.length,
      });
      // Record one version row per resolution batch, branched from the
      // source's current head. Source label captures the operation.
      let versionId: string | undefined;
      try {
        const head = documentVersions.getHead(fileId);
        const source = accept.length > 0 ? 'accept' : 'reject';
        const v = documentVersions.addVersion({
          externalDocId: fileId,
          parentId: head?.id ?? null,
          source,
          storageId: fileId,
          byteSize: newBytes.length,
          notes: `Resolved ${changed} revision${changed === 1 ? '' : 's'} (${accept.length} accept, ${reject.length} reject)`,
        });
        versionId = v.id;
      } catch (err) {
        console.warn(
          '[revisions/resolve] addVersion failed:',
          err instanceof Error ? err.message : err,
        );
      }
      const paragraphs = extractRedlineParagraphs(newBytes);
      res.json({
        ok: true,
        accepted: accept,
        rejected: reject,
        changed,
        version_id: versionId,
        paragraphs,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'resolve failed' });
    }
  },
);

app.use(
  '/api',
  createFilesRouter({ store: fileStore, maxUploadBytes: config.files.maxUploadBytes }),
);
if (config.kb.enabled) {
  app.use(
    '/api/kb',
    requireAuth,
    createKbRouter({
      store: kbStore,
      markitdownBaseUrl: config.markitdown.baseUrl,
      maxUploadBytes: config.files.maxUploadBytes,
    }),
  );
}

app.get('/api/health', async (_req, res) => {
  try {
    let reachable = false;
    let runtimeError = '';

    try {
      await fetch(`${config.agent.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      reachable = true;
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : 'Health check failed';
    }

    if (!reachable) {
      try {
        const probe = await fetch(config.agent.baseUrl, {
          signal: AbortSignal.timeout(5_000),
        });
        reachable = probe.status > 0;
        runtimeError = '';
      } catch (error) {
        runtimeError = error instanceof Error ? error.message : runtimeError;
      }
    }

    res.json({
      status: 'ok',
      title: config.title,
      agent: {
        name: config.agent.name,
        description: config.agent.description,
        model: config.agent.model,
        reachable,
      },
      tools: activeTools().map((t) => ({ name: t.name, description: t.description })),
      skills: skillState.skills.map((s) => ({
        skillName: s.skillName,
        name: s.name,
        description: s.description,
        sourceId: s.sourceId,
      })),
      mcp: mcp.status,
      allowedHttpHosts: toolCtx.allowedHttpHosts ?? [],
      kb: config.kb.enabled
        ? { enabled: true, ...kbStore.count(null) }
        : { enabled: false },
      modelAgents: Object.fromEntries(
        Object.entries(config.modelAgents).map(([id, t]) => [id, { baseUrl: t.baseUrl }]),
      ),
      authProviders: config.oauth.providers.map((p) => ({ id: p.id, label: p.label })),
      cloudProviders: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        modelIds: p.modelIds,
        ...(p.hint ? { hint: p.hint } : {}),
        ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
      })),
      demo: config.demo.password ? { email: config.demo.email, password: config.demo.password } : undefined,
    });
  } catch (error) {
    res.json({
      status: 'ok',
      title: config.title,
      agent: {
        name: config.agent.name,
        description: config.agent.description,
        model: config.agent.model,
        reachable: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      },
      tools: activeTools().map((t) => ({ name: t.name, description: t.description })),
      skills: skillState.skills.map((s) => ({
        skillName: s.skillName,
        name: s.name,
        description: s.description,
        sourceId: s.sourceId,
      })),
      mcp: mcp.status,
      allowedHttpHosts: toolCtx.allowedHttpHosts ?? [],
      kb: config.kb.enabled
        ? { enabled: true, ...kbStore.count(null) }
        : { enabled: false },
      modelAgents: Object.fromEntries(
        Object.entries(config.modelAgents).map(([id, t]) => [id, { baseUrl: t.baseUrl }]),
      ),
      authProviders: config.oauth.providers.map((p) => ({ id: p.id, label: p.label })),
      cloudProviders: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        modelIds: p.modelIds,
        ...(p.hint ? { hint: p.hint } : {}),
        ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
      })),
      demo: config.demo.password ? { email: config.demo.email, password: config.demo.password } : undefined,
    });
  }
});

app.get('/api/token-budget', requireAuth, (req, res) => {
  const ownerEmail = getSessionUser(req)?.email;
  if (!ownerEmail) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json({ tokenBudget: tokenBudget.getSummary(ownerEmail) });
});

// Platform bridge config for mothership integration
const platformBridgeConfig: PlatformBridgeConfig = {
    platformToken: config.platform?.token,
};

// Webhook endpoint for mothership (install/uninstall/dm/ping). The DM handler
// delegates to runWebhookChatTurn from @teamsuzie/platform-bridge, which owns
// the "drain runChatTurn into a single string + frame the prompt for an
// agent-to-agent reply" boilerplate. We just supply the agent target, tools,
// and base system prompt — all suzielaw-specific.
if (config.platform?.token) {
    app.use('/api/webhook/mothership', createWebhookRouter(platformBridgeConfig, {
        onInstall: async (ctx) => {
            console.log(`[SUZIELAW] Installed by org ${ctx.org_id}, agent_id=${ctx.agent_id}`);
        },
        onUninstall: async (ctx) => {
            console.log(`[SUZIELAW] Uninstalled by org ${ctx.org_id}`);
        },
        onDirectMessage: async (ctx) => {
            try {
                const transcript = (ctx.context as { transcript?: Array<{ from: string; text: string }> } | undefined)?.transcript;
                const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
                const response = await runWebhookChatTurn({
                    agent: resolveAgentTarget(config.agent.model, {}, config.agent),
                    tools: activeTools(),
                    toolCtx,
                    systemPrompt: config.agent.systemPrompt.replace('{{DATE}}', today),
                    fromAgentName: ctx.from_agent.name,
                    message: ctx.message,
                    transcript,
                    maxIterations: config.tools.maxIterations,
                });
                return { response };
            } catch (err: any) {
                console.error(`[SUZIELAW] DM from ${ctx.from_agent.name} failed:`, err.message);
                return { response: `[Suzie Law could not respond: ${err.message}]` };
            }
        },
    }));
}

// Platform-proxied requests bypass session auth via virtual session
const validatePlatformRequest = createPlatformRequestMiddleware(platformBridgeConfig);

app.post('/api/chat', validatePlatformRequest, requireAuth, async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const history = Array.isArray(req.body?.history) ? (req.body.history as ChatMessage[]) : [];
  const sessionId = String(req.body?.sessionId || '').trim();
  const attachmentIds = Array.isArray(req.body?.attachmentIds)
    ? (req.body.attachmentIds as unknown[]).map(String).filter(Boolean)
    : [];
  // When set, this is a matter-scoped persisted chat. Server auto-attaches
  // matter docs and persists user + assistant messages on completion.
  const chatId = String(req.body?.chatId || '').trim();
  // Per-request model override (from the Settings model picker). The
  // default model is always allowed — it's the demo-budget path. Other
  // models are accepted only when the user has a BYOK key for the
  // model's provider; the chat then routes to the provider's public
  // endpoint with the user's key, bypassing demo metering.
  const requestedModelRaw = String(req.body?.model || '').trim();
  const sessionEmailEarly = getSessionUser(req)?.email;
  if (requestedModelRaw && requestedModelRaw !== config.agent.model) {
    const provider = providerForModel(requestedModelRaw);
    const hasUserKey = !!(
      provider &&
      sessionEmailEarly &&
      modelSettings.getProviderKey(sessionEmailEarly, provider.id)
    );
    if (!provider || !hasUserKey) {
      res.status(400).json({
        error: 'model_not_allowed',
        allowed: [config.agent.model],
        message: provider
          ? `Add your ${provider.label} key in Settings to use ${requestedModelRaw}.`
          : `Model ${requestedModelRaw} is not configured for this app.`,
      });
      return;
    }
  }
  const requestedModel = requestedModelRaw;
  // Per-request persona — picked at "new chat" time and sent on every turn.
  const personaId = String(req.body?.personaId || '').trim();
  // When the user launches a workflow from the library, the client
  // sends its id on the next turn so the runtime can route based on the
  // workflow's `output_mode` (inject `generate_docx` and add a nudge for
  // tool-bound modes; pass through unchanged for `inline_chat`). One-shot:
  // the client sends this only on the launch turn, not on follow-ups.
  const workflowId = String(req.body?.workflowId || '').trim();
  const ownerEmail = getSessionUser(req)?.email;
  const persona = personaId && ownerEmail ? personaRegistry.get(personaId, ownerEmail) : null;

  // Per-model routing: env defaults overlaid with the user's per-model
  // overrides (saved via /api/model-settings). resolveAgentTarget picks the
  // right base URL + key for the requested model id. BYOK additionally
  // overlays a per-(user, provider) cloud key — when set, it routes the
  // call to the provider's public endpoint with the user's own key,
  // bypassing the demo-budget path entirely.
  const effectiveModel = requestedModel || persona?.model || config.agent.model;
  const userRegistry = modelSettings.effectiveRegistry(ownerEmail ?? null);
  // BYOK overlay: for any model that maps to a known cloud provider AND
  // for which the caller has a saved key, rewrite the registry entry to
  // route the request through the provider's public endpoint with the
  // user's own credentials. We apply this to BOTH the chat model and
  // the simpleModel — auxiliary calls (auto-titling, column drafting,
  // KB hyde) all use simpleModel and would otherwise still hit the
  // demo backend even with a BYOK key set. The wire id rewrite handles
  // providers whose UI ids include a namespace prefix (`anthropic/...`,
  // `openai/...`) but whose APIs expect bare ids on the wire.
  function overlayBYOK(uiModelId: string): void {
    if (!ownerEmail) return;
    const cloudProvider = providerForModel(uiModelId);
    if (!cloudProvider) return;
    const userKey = modelSettings.getProviderKey(ownerEmail, cloudProvider.id);
    if (!userKey) return;
    userRegistry[uiModelId] = {
      baseUrl: cloudProvider.baseUrl,
      apiKey: userKey,
      model: wireModelIdFor(uiModelId),
    };
  }
  overlayBYOK(effectiveModel);
  overlayBYOK(config.agent.simpleModel);
  const agent = resolveAgentTarget(effectiveModel, userRegistry, config.agent);
  const countHostedTokens =
    !!ownerEmail &&
    agent.baseUrl === config.agent.baseUrl &&
    (agent.apiKey || '') === (config.agent.apiKey || '');

  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  if (ownerEmail && countHostedTokens) {
    try {
      tokenBudget.assertCanSpend(ownerEmail);
    } catch (error) {
      res.status(402).json({
        error: 'token_limit_exceeded',
        message: error instanceof Error ? error.message : 'Demo token allowance used',
        tokenBudget: tokenBudget.getSummary(ownerEmail),
      });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const abort = new AbortController();
  // res.close (not req.close): fires when the response stream ends — i.e.,
  // the client actually disconnected. req.close in Express 5 / Node 22+ can
  // fire as soon as the request body is fully consumed by middleware, which
  // would abort the upstream LLM call before it ever runs.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  // Per-turn paperclip uploads (chat session bucket).
  const turnAttachments: FileRecord[] =
    sessionId && attachmentIds.length > 0
      ? fileStore.getMany(sessionId, attachmentIds)
      : [];

  // Persisted-chat attachment: matter-scoped chats auto-attach every doc
  // in the matter; review-scoped chats (workspaceId prefixed `review:`)
  // narrow that to just the review's row set. Top-level Assistant chats
  // (workspaceId prefixed `assistant:`) are standalone — no auto-attach.
  // Matter and review chats resolve file bytes from the matter's bucket,
  // since that's where uploads land — the review-scoped chat's
  // `workspaceId` is just a namespace marker, not a file-store bucket.
  let persistedChat: ReturnType<ChatsStore['getChat']> = null;
  // The matter id whose `fileStore` bucket holds the doc bytes for this
  // chat. For review-scoped chats this differs from `persistedChat.workspaceId`,
  // so we surface it for both attachment lookup and the docTools session.
  // Empty string for top-level Assistant chats — they have no matter bucket.
  let chatBucketMatterId = '';
  const matterAttachments: FileRecord[] = [];
  if (chatId) {
    persistedChat = chats.getChat(chatId);
    if (!persistedChat) {
      send({ type: 'error', message: 'chat not found' });
      res.end();
      return;
    }
    if (persistedChat.workspaceId.startsWith('assistant:')) {
      // Top-level Assistant chat — standalone, no matter docs.
    } else if (persistedChat.workspaceId.startsWith('review:')) {
      const reviewId = persistedChat.workspaceId.slice('review:'.length);
      const review = reviews.getReview(reviewId);
      if (!review) {
        send({ type: 'error', message: 'review not found for chat' });
        res.end();
        return;
      }
      chatBucketMatterId = review.workspaceId;
      for (const doc of reviews.listDocuments(reviewId)) {
        const rec = fileStore.get(chatBucketMatterId, doc.externalDocId);
        if (rec) matterAttachments.push(rec);
      }
    } else {
      chatBucketMatterId = persistedChat.workspaceId;
      for (const doc of workspaces.listDocuments(chatBucketMatterId, {})) {
        const rec = fileStore.get(chatBucketMatterId, doc.externalDocId);
        if (rec) matterAttachments.push(rec);
      }
    }
  }
  // For top-level Assistant chats we resolve attachment bytes from the
  // user's per-render session bucket (paperclip uploads), which is what
  // the docTools / file URLs already use.
  const docToolsSession = chatBucketMatterId || sessionId;

  // Dedupe by file id so a paperclip upload that's also a matter doc doesn't
  // appear twice in the [Attachments] block.
  const allAttachments: FileRecord[] = [];
  const seenAttachmentIds = new Set<string>();
  for (const rec of [...matterAttachments, ...turnAttachments]) {
    if (seenAttachmentIds.has(rec.id)) continue;
    seenAttachmentIds.add(rec.id);
    allAttachments.push(rec);
  }
  const attachmentContext = buildAttachmentContext(allAttachments);
  const citationProtocol = buildCitationProtocolBlock(allAttachments);
  const userContent = attachmentContext
    ? `${attachmentContext}\n\n${citationProtocol}\n\n[Message]\n${message}`
    : message;

  const messages: ChatMessage[] = [...history, { role: 'user', content: userContent }];

  // Per-turn document tools (lazy convert, navigate, draft, export). Only
  // appears when markitdown-agent is configured; otherwise just nav/draft on
  // any docs the app put in the store directly.
  //
  // In matter- or review-scoped chats, doc lookup has to use the matter's
  // bucket — that's where matter docs live in the file store. The
  // request's `sessionId` (= chatId) doesn't hold those bytes, and a
  // review-scoped chat's `workspaceId` is `review:<id>` (a namespace
  // marker, not a file-store key). `chatBucketMatterId` resolves to the
  // matter id for both kinds of persisted chats.
  const docTools = buildDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    docStore,
    markitdownBaseUrl: config.markitdown.baseUrl,
  });
  const diffTools = buildDiffTools({
    sessionId: docToolsSession,
    fileStore,
    markitdownBaseUrl: config.markitdown.baseUrl,
    originUrl: config.publicUrl,
  });
  const proposeEditsTools = buildProposeEditsTools({
    sessionId: docToolsSession,
    fileStore,
    originUrl: config.publicUrl,
    documentVersions,
  });
  const findInDocumentTools = buildFindInDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    docStore,
  });
  const replicateDocumentTools = buildReplicateDocumentTools({
    sessionId: docToolsSession,
    fileStore,
    originUrl: config.publicUrl,
    documentVersions,
  });

  // Workflow-bound tool injection. Lookup is best-effort: an unknown
  // workflowId silently degrades to inline_chat behaviour rather than
  // failing the turn, so a stale id never blocks the user.
  const activeWorkflow = workflowId ? workflows.get(workflowId) : null;
  const workflowDocxTools =
    activeWorkflow?.outputMode === 'generate_docx'
      ? buildGenerateDocxTools({
          sessionId: docToolsSession,
          fileStore,
          originUrl: config.publicUrl,
          documentVersions,
        })
      : [];

  const turnTools = [
    ...activeTools(),
    ...docTools,
    ...diffTools,
    ...proposeEditsTools,
    ...findInDocumentTools,
    ...replicateDocumentTools,
  ];

  // Persona's system prompt replaces the default Counsel prompt; skills always
  // append; allowedTools/blockedTools filters the tool set for this turn.
  const turnConfig = applyPersona({
    defaultSystemPrompt: config.agent.systemPrompt.replace('{{DATE}}', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })),
    skillSystemPrompt: skillState.systemPrompt,
    tools: turnTools,
    persona,
  });

  // Apply per-turn overrides for the active workflow's output_mode.
  // For generate_docx, this injects the docx tools, filters out the
  // competing markdown-drafting + template tools, and appends a
  // system-prompt nudge — see workflow-overrides.ts for the routing
  // matrix and the rationale (the model otherwise reaches for
  // create_document/write_section despite the nudge, because the
  // baseline prompt's drafting guidance is longer than a single
  // paragraph). Pass-through for inline_chat / tabular_review / null.
  const overridden = applyWorkflowOverrides({
    baseTools: turnConfig.tools,
    baseSystemPrompt: turnConfig.systemPrompt,
    workflow: activeWorkflow,
    generateDocxTools: workflowDocxTools,
  });
  turnConfig.tools = overridden.tools;
  turnConfig.systemPrompt = overridden.systemPrompt;

  // Accumulators so we can persist the assistant turn into chat_messages
  // when the chat is matter-scoped. Tool events are kept as-is; the final
  // text gets parseResponse'd to strip the citation sentinel block.
  let assistantText = '';
  const collectedToolEvents: unknown[] = [];

  try {
    for await (const event of runChatTurn({
      agent,
      messages,
      tools: turnConfig.tools,
      toolCtx,
      systemPrompt: turnConfig.systemPrompt,
      maxIterations: config.tools.maxIterations,
      fetchImpl:
        ownerEmail && countHostedTokens
          ? createTokenMeteredFetch({
              budget: tokenBudget,
              ownerEmail,
              source: 'chat',
              model: agent.model,
              enabled: true,
              fallbackTokens: config.tokenBudget.fallbackTokensPerCall,
            })
          : fetch,
      signal: abort.signal,
    })) {
      send(event);
      if (persistedChat) {
        if (event.type === 'chunk') {
          assistantText += event.text;
        } else if (
          event.type === 'tool_call' ||
          event.type === 'tool_result' ||
          event.type === 'tool_error'
        ) {
          collectedToolEvents.push(event);
        }
      }
      if (event.type === 'done' || event.type === 'error') break;
    }
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : 'Chat request failed',
      code: error instanceof TokenLimitExceededError ? 'token_limit_exceeded' : undefined,
    });
  } finally {
    if (persistedChat) {
      try {
        // Persist the user turn (the original message, not the embellished
        // userContent — we don't want the [Attachments] block in stored history).
        chats.appendMessage({
          chatId: persistedChat.id,
          role: 'user',
          content: message,
        });

        const parsed = parseResponse(assistantText, {
          knownDocs: allAttachments.map((a) => a.id),
        });
        chats.appendMessage({
          chatId: persistedChat.id,
          role: 'assistant',
          content: parsed.text,
          toolEvents:
            collectedToolEvents.length > 0
              ? JSON.stringify(collectedToolEvents)
              : null,
          citations:
            parsed.citations.length > 0
              ? JSON.stringify(parsed.citations)
              : null,
        });

        // Auto-title in two passes: synchronous trim of the first message
        // so the sidebar updates immediately on first turn, then a
        // background LLM call that upgrades to a short, sentence-case
        // title (e.g. "NDA confidentiality scope" instead of "Can you
        // redline this NDA from buyer perspective"). Best-effort — any
        // failure leaves the synchronous title in place.
        if (persistedChat.name === 'New chat') {
          const firstLine = message.split('\n')[0]?.trim() ?? '';
          const provisional =
            firstLine.length > 0
              ? firstLine.slice(0, 60) + (firstLine.length > 60 ? '…' : '')
              : 'New chat';
          if (provisional !== persistedChat.name) {
            chats.updateChat(persistedChat.id, { name: provisional });
          }
          // Fire-and-forget the polish pass after we end the response
          // stream so the user doesn't wait on it. Pinned to the simple
          // model + always-fresh fetch (no token-metering — it's cheap
          // and counts against the chat budget anyway).
          const titleAgent = resolveAgentTarget(
            config.agent.simpleModel,
            userRegistry,
            config.agent,
          );
          const persistedChatId = persistedChat.id;
          const userTurnText = message;
          const replyText = parsed.text;
          void (async () => {
            try {
              const polished = await draftChatTitle(userTurnText, replyText, {
                baseUrl: titleAgent.baseUrl,
                apiKey: titleAgent.apiKey,
                model: titleAgent.model,
                extraBody: config.agent.extraBody,
              });
              if (!polished) return;
              const current = chats.getChat(persistedChatId);
              // Only overwrite if the chat is still on the provisional
              // title — if the user renamed it manually in the meantime,
              // respect that.
              if (current && current.name === provisional) {
                chats.updateChat(persistedChatId, { name: polished });
              }
            } catch (err) {
              console.warn(
                '[chat-title] background polish failed:',
                err instanceof Error ? err.message : err,
              );
            }
          })();
        }
      } catch (err) {
        // Don't fail the response stream just because persistence broke.
        console.error(
          'Failed to persist chat messages:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    res.end();
  }
});

app.get('/api/approvals', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  const items = await approvals.list({
    status: status === 'all' ? undefined : (status as 'pending' | 'approved' | 'rejected' | 'dispatched' | 'failed'),
  });
  res.json({ items });
});

app.post('/api/approvals/:id/review', async (req, res) => {
  const id = req.params.id;
  const verdict = req.body?.verdict === 'approve' ? 'approve' : 'reject';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

  try {
    const reviewed = await approvals.review(id, {
      reviewer_id: 'human',
      verdict,
      reason,
    });
    res.json({ ok: true, item: reviewed });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Review failed',
    });
  }
});

/**
 * Wipe every user-content table — KB, matters/folders/docs, chats,
 * reviews, on-disk files. Auth-gated; the demo build only has one user
 * anyway. Returns counts so the UI can show "removed N matters, M docs,
 * K kb chunks". Personas, prompts, model-settings survive — those feel
 * more like configuration than content.
 */
app.post('/api/admin/reset', requireAuth, async (_req, res) => {
  const startedAt = Date.now();
  console.log('[admin/reset] starting full content wipe');
  try {
    // 1. KB. Delete each document through the store so vec0 / fts5
    //    sidecars stay in sync — direct DELETEs would leave orphans.
    const kbDocs = kbStore.list(null);
    let kbDocsDeleted = 0;
    let kbChunksDeleted = 0;
    for (const doc of kbDocs) {
      try {
        kbStore.delete(doc.id);
        kbDocsDeleted += 1;
        kbChunksDeleted += doc.chunkCount;
      } catch (err) {
        console.warn(`[admin/reset] kbStore.delete(${doc.id}) failed:`, err);
      }
    }
    // 2. Everything else, in dependency order. A single transaction so a
    //    mid-flight error rolls back cleanly. We use raw exec rather than
    //    each store's per-row API — this is the wipe-everything path.
    const wipe = db.transaction(() => {
      db.exec(`
        DELETE FROM matter_doc_index;
        DELETE FROM chat_messages;
        DELETE FROM chats;
        DELETE FROM review_cells;
        DELETE FROM review_columns;
        DELETE FROM review_documents;
        DELETE FROM reviews;
        DELETE FROM workspace_documents;
        DELETE FROM folders;
        DELETE FROM workspaces;
      `);
    });
    wipe();
    // 3. File bytes (in-memory + disk persistence). docStore lives per
    //    chat session and ages out naturally, so we don't touch it here.
    const filesDeleted = fileStore.clearAll();
    const elapsed = Date.now() - startedAt;
    console.log(
      `[admin/reset] complete in ${elapsed}ms: ${kbDocsDeleted} kb doc(s), ${kbChunksDeleted} chunk(s), ${filesDeleted} file(s)`,
    );
    res.json({
      ok: true,
      kbDocsDeleted,
      filesDeleted,
    });
  } catch (err) {
    console.warn('[admin/reset] failed:', err instanceof Error ? err.message : err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : 'reset failed',
    });
  }
});

/**
 * Title-driven column-prompt drafting. The review column editor calls
 * this on title blur in `create` mode — the response is a starter
 * `{prompt, format}` the user can immediately edit. Model-driven so it
 * handles arbitrary column titles, not just a fixed preset pack.
 */
/**
 * Stream an .xlsx export of a review. Header row + one row per review
 * document; citation quotes attach as cell comments so a reviewer can
 * verify each answer without leaving Excel.
 */
/**
 * Launch a workflow as a review. Picks up the workflow's column config
 * and instantiates a review with one column per entry, one row per
 * supplied document. Returns a snapshot the client can navigate to
 * immediately; cells start `pending` (the existing run-pending flow
 * fills them in).
 */
app.post(
  '/api/matters/:matterId/reviews/from-workflow',
  requireAuth,
  (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const ownerId = getSessionUser(req)?.email;
    if (!ownerId) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const matter = workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const workflowId = String(body?.workflowId ?? '');
    const externalDocIds = Array.isArray(body?.externalDocIds)
      ? (body.externalDocIds as unknown[])
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!workflowId) {
      res.status(400).json({ error: 'workflowId is required' });
      return;
    }
    if (externalDocIds.length === 0) {
      res.status(400).json({ error: 'select at least one document' });
      return;
    }
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    // User-owned workflows are private to their creator unless shared
    // via the sharing surface — viewers can run, editors/owners can run.
    {
      const role = resolveWorkflowRole({
        workflows,
        members,
        workflowId,
        userId: ownerId,
      });
      if (!role) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
    }
    const columns = workflow.columnConfig ?? [];
    if (columns.length === 0) {
      res.status(400).json({ error: 'workflow has no review template' });
      return;
    }
    const REVIEW_VALID_FORMATS = [
      'text',
      'short_text',
      'date',
      'yes_no',
      'bullets',
      'money',
    ] as const;
    type ReviewCellFormat = (typeof REVIEW_VALID_FORMATS)[number];
    const validatedColumns = columns.filter((c) =>
      (REVIEW_VALID_FORMATS as readonly string[]).includes(c.format),
    );
    if (validatedColumns.length === 0) {
      res.status(400).json({ error: 'workflow has no valid columns' });
      return;
    }

    // Resolve doc names + mime types from the matter so we can populate
    // review_documents. Skip ids that aren't in the matter rather than
    // failing the whole call — the client may have stale data.
    const matterDocs = workspaces.listDocuments(matterId, {});
    const docByExternalId = new Map(
      matterDocs.map((d) => [d.externalDocId, d]),
    );

    try {
      const today = new Date().toLocaleDateString();
      const review = reviews.createReview({
        workspaceId: matterId,
        name: `${workflow.name} — ${today}`,
        description:
          workflow.description && workflow.description.trim().length > 0
            ? workflow.description
            : null,
      });
      for (let i = 0; i < validatedColumns.length; i++) {
        const c = validatedColumns[i]!;
        reviews.addColumn({
          reviewId: review.id,
          title: c.title,
          prompt: c.prompt,
          format: c.format as ReviewCellFormat,
          position: i,
        });
      }
      let added = 0;
      for (const externalDocId of externalDocIds) {
        const matterDoc = docByExternalId.get(externalDocId);
        if (!matterDoc) continue;
        reviews.addDocument({
          reviewId: review.id,
          externalDocId,
          name: matterDoc.name,
          mimeType: matterDoc.mimeType ?? null,
          position: added,
        });
        added += 1;
      }
      const snapshot = reviews.getReviewSnapshot(review.id);
      res.status(201).json({
        item: snapshot,
        skipped: externalDocIds.length - added,
      });
    } catch (err) {
      console.warn(
        '[reviews/from-workflow] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'failed',
      });
    }
  },
);

/**
 * Paragraph-level diff between two of a matter's documents. Used by
 * the matter-detail "Compare versions" surface (and the chat tool, though
 * the chat path doesn't go through this endpoint — it calls runDocumentDiff
 * directly with the file records it already has). Both files must live in
 * the matter's bucket; cross-matter diffs aren't supported here.
 */
app.post(
  '/api/matters/:matterId/diff',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const matter = workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const leftFileId = String(body?.leftFileId ?? '').trim();
    const rightFileId = String(body?.rightFileId ?? '').trim();
    if (!leftFileId || !rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId are required',
      });
      return;
    }
    if (leftFileId === rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId must reference different files',
      });
      return;
    }
    const left = fileStore.get(matterId, leftFileId);
    const right = fileStore.get(matterId, rightFileId);
    if (!left) {
      res.status(404).json({ error: `leftFileId not found: ${leftFileId}` });
      return;
    }
    if (!right) {
      res.status(404).json({ error: `rightFileId not found: ${rightFileId}` });
      return;
    }
    try {
      const result = await runDocumentDiff(left, right, {
        markitdownBaseUrl: config.markitdown.baseUrl,
      });
      res.json(result);
    } catch (err) {
      console.warn(
        '[matters/diff] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'diff failed',
      });
    }
  },
);

/**
 * Download the diff between two matter documents as a tracked-change
 * `.docx`. Word opens the result with native tracked changes; accept-all
 * reproduces the right document, reject-all reproduces the left. GET
 * (not POST) so a plain `<a download>` works.
 */
app.get(
  '/api/matters/:matterId/diff/download',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const matter = workspaces.getWorkspace(matterId);
    if (!matter) {
      res.status(404).json({ error: 'matter not found' });
      return;
    }
    const leftFileId = String(req.query.leftFileId ?? '').trim();
    const rightFileId = String(req.query.rightFileId ?? '').trim();
    const author =
      String(req.query.author ?? '').trim() ||
      getSessionUser(req)?.email ||
      'Counsel';
    if (!leftFileId || !rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId query params are required',
      });
      return;
    }
    if (leftFileId === rightFileId) {
      res.status(400).json({
        error: 'leftFileId and rightFileId must reference different files',
      });
      return;
    }
    const left = fileStore.get(matterId, leftFileId);
    const right = fileStore.get(matterId, rightFileId);
    if (!left || !right) {
      res.status(404).json({
        error: !left
          ? `leftFileId not found: ${leftFileId}`
          : `rightFileId not found: ${rightFileId}`,
      });
      return;
    }
    try {
      const diff = await runDocumentDiff(left, right, {
        markitdownBaseUrl: config.markitdown.baseUrl,
      });
      const bytes = composeRedlineDocx({
        leftBytes: left.bytes,
        rightBytes: right.bytes,
        diff,
        author,
      });
      const filename = redlineDownloadFilename(left.name, right.name);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.send(bytes);
    } catch (err) {
      console.warn(
        '[matters/diff/download] failed:',
        err instanceof Error ? err.message : err,
      );
      res.status(500).json({
        error: err instanceof Error ? err.message : 'redline failed',
      });
    }
  },
);

app.get(
  '/api/matters/:matterId/reviews/:reviewId/export.xlsx',
  requireAuth,
  async (req, res) => {
    const matterId = String(req.params.matterId ?? '');
    const reviewId = String(req.params.reviewId ?? '');
    try {
      const { workbook, fileName } = await buildReviewWorkbook({
        reviews,
        workspaces,
        reviewId,
        matterId,
      });
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fileName}"`,
      );
      // exceljs streams directly to the response.
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'export failed';
      console.warn('[reviews/export]', message);
      const status = message === 'review not found' ? 404 : 500;
      res.status(status).json({ error: message });
    }
  },
);

app.post('/api/reviews/column/draft-prompt', requireAuth, async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) {
    res.status(400).json({ ok: false, error: 'title is required' });
    return;
  }
  const VALID_FORMATS = [
    'text',
    'short_text',
    'date',
    'yes_no',
    'bullets',
    'money',
  ] as const;
  type CellFormatLiteral = (typeof VALID_FORMATS)[number];
  const formatHintRaw =
    typeof req.body?.formatHint === 'string'
      ? req.body.formatHint.trim().toLowerCase()
      : undefined;
  const formatHint = (VALID_FORMATS as readonly string[]).includes(
    formatHintRaw ?? '',
  )
    ? (formatHintRaw as CellFormatLiteral)
    : undefined;
  const formatLocked = req.body?.formatLocked === true;
  try {
    const draft = await draftColumnPrompt(title, {
      baseUrl: config.agent.baseUrl,
      apiKey: config.agent.apiKey,
      model: config.agent.simpleModel,
      extraBody: config.agent.extraBody,
      formatHint,
      formatLocked,
    });
    // If the user explicitly picked the format, never let the model
    // override it — the lock is a UX promise, not just a hint.
    const finalFormat =
      formatLocked && formatHint ? formatHint : draft.format;
    res.json({ ok: true, prompt: draft.prompt, format: finalFormat });
  } catch (err) {
    console.warn(
      '[column-draft] failed:',
      err instanceof Error ? err.message : err,
    );
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : 'draft failed',
    });
  }
});

app.post('/api/session/reset', (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();
  if (sessionId) {
    fileStore.clearSession(sessionId);
    docStore.clearSession(sessionId);
  }
  res.json({ ok: true });
});

app.use(express.static(clientDistDir));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  res.sendFile(path.join(clientDistDir, 'index.html'), (error) => {
    if (error) {
      next();
    }
  });
});

async function main(): Promise<void> {
  await bootstrapSkills();
  rebuildToolCtx();
  await bootstrapMcp();
  await bootstrapTemplates();

  // Register with mothership marketplace on startup (if configured)
  if (config.platform?.url) {
    registerWithPlatform(
      { platformUrl: config.platform.url, registrationToken: config.platform.registrationToken },
      {
        slug: 'suzielaw',
        name: 'Suzie Law',
        description: 'Open-source AI legal assistant — research, drafting, document review',
        provider_name: 'Team Suzie',
        base_url: config.publicUrl,
        health_endpoint: '/api/health',
        chat_endpoint: '/api/chat',
        webhook_endpoint: '/api/webhook/mothership',
        capabilities: { tools: ['vector_search', 'legal_research', 'document_drafting'], features: ['sse_streaming'] },
        version: '0.1.0',
      }
    ).catch(err => console.warn('[SUZIELAW] Platform registration failed:', err.message));
  }

  const server = app.listen(config.port, () => {
    console.log(`${config.title} listening on ${config.publicUrl}`);
    if (toolCtx.allowedHttpHosts && toolCtx.allowedHttpHosts.length > 0) {
      console.log(`http_request allow-list: ${toolCtx.allowedHttpHosts.join(', ')}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    server.close();
    await mcp.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
