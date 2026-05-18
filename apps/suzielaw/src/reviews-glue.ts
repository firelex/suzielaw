import { buildRagRunCellAdapter, makeStreamCompletion } from '@teamsuzie/grid-review-rag';
import { rewriteQueryAsHypothetical, type WorkspaceRag } from '@teamsuzie/kb';
import type { RunCellAdapter } from '@teamsuzie/grid-review';
import type { Request } from 'express';

import type { InMemoryFileStore } from './files.js';
import { convertFileToMarkdown } from './document-tools.js';
import { createTokenMeteredFetch, type TokenBudgetStore } from '@teamsuzie/hosted-demo';
import { getSessionUser } from './auth.js';

export interface BuildReviewRunAdapterOptions {
  fileStore: InMemoryFileStore;
  rag: WorkspaceRag;
  markitdownBaseUrl: string;
  agentBaseUrl: string;
  agentApiKey: string | undefined;
  model: string;
  hydeModel: string;
  extraBody?: Record<string, unknown>;
  topK?: number;
  tokenBudget?: TokenBudgetStore;
  fallbackTokensPerCall?: number;
}

/**
 * Suzielaw's review-run adapter — thin shim over the extracted upstream
 * `buildRagRunCellAdapter`. Wires in suzielaw-specific bits: per-request
 * token metering (via `@teamsuzie/hosted-demo`) and the existing
 * `InMemoryFileStore` for unindexed-doc fallback. The HyDE retrieval and
 * cell-streaming logic itself lives in `@teamsuzie/grid-review-rag`.
 */
export function buildReviewRunAdapter(opts: BuildReviewRunAdapterOptions): RunCellAdapter {
  return async function* runReviewCell(args) {
    const ownerEmail = args.request ? getSessionUser(args.request as Request)?.email : null;

    const meteredFetch =
      opts.tokenBudget && ownerEmail
        ? createTokenMeteredFetch({
            budget: opts.tokenBudget,
            ownerEmail,
            source: 'review-cell',
            model: opts.model,
            enabled: true,
            fallbackTokens: opts.fallbackTokensPerCall ?? 0,
          })
        : fetch;
    const hydeFetch =
      opts.tokenBudget && ownerEmail
        ? createTokenMeteredFetch({
            budget: opts.tokenBudget,
            ownerEmail,
            source: 'review-hyde',
            model: opts.hydeModel,
            enabled: true,
            fallbackTokens: opts.fallbackTokensPerCall ?? 0,
          })
        : fetch;

    const adapter = buildRagRunCellAdapter({
      rag: opts.rag,
      markitdownBaseUrl: opts.markitdownBaseUrl,
      topK: opts.topK,
      hydeRewrite: (question, format) =>
        rewriteQueryAsHypothetical(question, format, {
          baseUrl: opts.agentBaseUrl,
          apiKey: opts.agentApiKey,
          model: opts.hydeModel,
          extraBody: opts.extraBody,
          fetchImpl: hydeFetch,
        }),
      llmStream: makeStreamCompletion({
        baseUrl: opts.agentBaseUrl,
        apiKey: opts.agentApiKey,
        model: opts.model,
        extraBody: opts.extraBody,
        fetchImpl: meteredFetch,
      }),
      loadFileBytes: async (workspaceId, externalDocId) => {
        const record = opts.fileStore.get(workspaceId, externalDocId);
        if (!record) return null;
        return { bytes: record.bytes, name: record.name, mimeType: record.mimeType };
      },
      convertToMarkdown: async (record) => {
        const markdown = await convertFileToMarkdown(
          {
            id: 'inline',
            sessionId: 'inline',
            name: record.name,
            mimeType: record.mimeType,
            size: record.bytes.byteLength,
            bytes: Buffer.isBuffer(record.bytes) ? record.bytes : Buffer.from(record.bytes),
            createdAt: Date.now(),
          },
          { markitdownBaseUrl: opts.markitdownBaseUrl },
        );
        return { markdown };
      },
    });

    yield* adapter(args);
  };
}
