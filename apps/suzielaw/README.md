# suzielaw

The Suzie Law chat assistant. Express + React + Vite, copied from Team Suzie's `starter-chat` and adapted with legal-specific content.

For repo-level context (layout, sibling-clone setup, why a separate repo) see the top-level [`suzielaw/README.md`](../../README.md). For the underlying chat shell, tool-use loop, skills bridge, and MCP client — none of which we re-implemented — see the upstream [`starter-chat` README](https://github.com/firelex/open_teamsuzie/blob/main/apps/starters/starter-chat/README.md). This README only covers what's app-specific.

## Run

The full setup (sibling clone, Node 20, `pnpm deps:build`) is in the [top-level README](../../README.md#build-your-app-this-afternoon). In short:

```bash
cp .env.example .env
#   → fill in SUZIELAW_AGENT_API_KEY (and SUZIELAW_AGENT_BASE_URL / SUZIELAW_MODEL for another provider)
#   → optionally add SUZIELAW_GOOGLE_CLIENT_ID / SUZIELAW_GOOGLE_CLIENT_SECRET
cd ../.. && pnpm dev:full    # Postgres + Redis (docker compose), markitdown-agent, then this app
```

Open <http://localhost:17502> and sign in as `demo@example.com` / `demo`. Login needs Postgres and Redis; `pnpm --filter @suzielaw/assistant dev` runs only this app and expects them to be up already. For a quick look without them, add `SUZIELAW_AUTH_BYPASS=true` to `.env` (never on a shared deployment: every request becomes the demo user).

## Configuration

Set in `.env`. Same shape as upstream `starter-chat`'s env, with `STARTER_CHAT_` renamed to `SUZIELAW_`. The defaults that matter:

| Variable | Default | Purpose |
|---|---|---|
| `SUZIELAW_AGENT_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode` | OpenAI-compatible base URL |
| `SUZIELAW_MODEL` | `qwen3.6-plus` | Model string sent to `/v1/chat/completions` (must support tool use) |
| `SUZIELAW_AGENT_API_KEY` | — | Bearer token for the model provider |
| `SUZIELAW_GOOGLE_CLIENT_ID` / `SUZIELAW_GOOGLE_CLIENT_SECRET` | — | Enables the Google sign-in button |
| `SUZIELAW_PORT` / `SUZIELAW_CLIENT_PORT` | `17501` / `17502` | Backend / frontend ports |
| `SUZIELAW_TITLE` | `Suzie Law` | App title shown in the sidebar |
| `SUZIELAW_AGENT_NAME` | `Counsel` | Assistant display name |
| `SUZIELAW_VECTOR_DB_BASE_URL` | `http://localhost:3006` | Where the `vector_search` tool POSTs |
| `SUZIELAW_TOOL_MAX_ITERATIONS` | `100` | Cap on tool-use loop turns |

Skills, MCP, and the http-allow-list work exactly as upstream — see the upstream README. The `.env.example` lists all of them with comments.

## Layout

```
apps/suzielaw/
  src/                Express backend (auth, chat, files, matters, reviews, KB)
    config.ts         SUZIELAW_* env config
    index.ts          server bootstrap
    tools/            legal-specific tools (legal research, templates, diffs, document edits)
  client/
    src/
      App.tsx         AppShell + Sidebar + Routes
      pages/
        assistant.tsx      General Counsel chat
        matters.tsx        Matter workspace index
        matter-detail.tsx  Matter documents, reviews, and chats
        review-detail.tsx  Tabular review and structured extraction
        library.tsx        Legal workflow library
        personas.tsx       Built-in and user-created personas
        settings.tsx       Model picker and local app settings
```

## Generate PowerPoint decks (pptx-agent)

The `Counsel` assistant can generate `.pptx` slide decks via Team Suzie's `pptx-agent` HTTP service plus the bundled `presentations` skill. Setup:

1. **Start pptx-agent.** In a separate terminal, from your sibling teamsuzie clone:

   ```bash
   cd ../open_teamsuzie
   cp apps/agents/pptx-agent/.env.example apps/agents/pptx-agent/.env
   #   → set DEFAULT_LLM_MODEL (or PPTX_AGENT_MODEL) and any provider key
   pnpm dev:pptx-agent
   ```

2. **Point suzielaw at it.** In `apps/suzielaw/.env`, uncomment:

   ```bash
   SUZIELAW_SKILLS_DIR=../../../open_teamsuzie/packages/skills/templates
   SUZIELAW_SKILLS_ALLOW=presentations
   SUZIELAW_SKILL_VAR_PPTX_AGENT_URL=http://localhost:3009
   SUZIELAW_SKILL_VAR_AGENT_API_KEY=
   SUZIELAW_SKILL_VAR_AGENT_SLUG=suzielaw
   ```

3. **Restart the assistant.** The skill markdown is loaded into the system prompt at startup; the model will know how to call the pptx-agent via `http_request`.

4. **Try it.** Open the Library, run the *Draft a board update deck* workflow. Counsel will draft the outline, call the pptx-agent, and return a download link when the job finishes (60–120 seconds).

> **Note on async.** Deck generation is asynchronous — the agent submits a job and the pptx-agent fires a webhook when complete. Without an admin service implementing `GET /api/agents/resolve-by-key`, the webhook delivery silently fails and Counsel will need to poll. That's fine for local dev; in production you'd run the Team Suzie admin service alongside.

## Document templates

Markdown layouts for the document types lawyers actually produce live in `apps/suzielaw/templates/`. Each file has YAML frontmatter (id, title, description, document_type, when_to_use) and a body of the layout itself — parties block, recitals, IRAC sections, signature block, etc. — with `[BRACKETED PLACEHOLDERS]` to swap in.

| Template | Purpose |
|---|---|
| `agreement` | Generic contract layout (parties, recitals, definitions, operative terms, boilerplate) |
| `memorandum` | Internal IRAC memo (Issue / Brief Answer / Facts / Discussion / Conclusion) |
| `legal-opinion` | Formal opinion letter to a third party (assumptions, opinions, qualifications, reliance) |
| `brief` | Litigation brief (caption, preliminary statement, statement of facts, argument, conclusion) |
| `board-minutes` | Board meeting minutes (attendance, motions, votes, executive session, adjournment) |
| `engagement-letter` | Client engagement letter (scope, fees, conflicts, file retention) |
| `demand-letter` | Pre-litigation demand letter (background, legal basis, demand, deadline) |
| `client-alert` | Client alert (what happened / who it affects / what to do / open questions) |
| `resolution` | Written consent / resolution (recitals + RESOLVED clauses + omnibus authorization) |

The model reaches them through two tools: `list_templates` (catalog browse) and `get_template({id})` (fetch markdown body). Add new templates by dropping a frontmatter-prefixed `.md` file in `templates/` and restarting the server.

## Legal research

Three tools give the model one surface over 26 official sources in 19 jurisdictions (see the [top-level README](../../README.md) for the full list):

| Tool | Purpose |
|---|---|
| `legal_search` | Search case law and legislation, routed by jurisdiction or `source_id` |
| `legal_get_document` | Fetch a document's full text by the `source_id` and `doc_id` from a search hit (long texts truncated unless `truncate=false`) |
| `legal_find_in_document` | Find the articles of a long piece of legislation that contain a keyword |

The providers live in `src/tools/legal-research/providers/`, one file each. Most work without a key. CourtListener works unauthenticated at a low rate limit; Légifrance, Judilibre and Indian Kanoon register only when their keys are set:

```bash
SUZIELAW_COURTLISTENER_TOKEN=<token from https://www.courtlistener.com/profile/api/>
SUZIELAW_PISTE_CLIENT_ID=...  SUZIELAW_PISTE_CLIENT_SECRET=...   # Légifrance
SUZIELAW_JUDILIBRE_API_KEY=...
SUZIELAW_INDIANKANOON_API_KEY=...
```

## Adding legal content

The library, prompt seeds, and legal review presets live here:

- `client/src/data/practice-areas.ts` — taxonomy
- `src/data/prompts.ts` — seed prompt catalog
- `client/src/data/workflows.ts` — workflow agents (multi-step)
- `client/src/data/legal-presets.ts` — tabular review presets
- `src/data/review-templates.ts` — backend review template seeds

Tools for legal-specific actions live in `src/tools/`. Wire them into the agent loop in `src/index.ts`.
