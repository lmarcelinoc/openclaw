import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateMessagesTokens } from "../agents/compaction.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerContextEngine } from "./registry.js";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  ContextEngineRuntimeContext,
  IngestResult,
} from "./types.js";

const log = createSubsystemLogger("context-engine/legacy");

const DEFAULT_PROACTIVE_THRESHOLD = 0.8;

/**
 * LegacyContextEngine wraps the existing compaction behavior behind the
 * ContextEngine interface, preserving 100% backward compatibility.
 *
 * - ingest: no-op (SessionManager handles message persistence)
 * - assemble: pass-through (existing sanitize/validate/limit pipeline in attempt.ts handles this)
 * - compact: delegates to compactEmbeddedPiSessionDirect
 */
export class LegacyContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "legacy",
    name: "Legacy Context Engine",
    version: "1.0.0",
  };

  async ingest(_params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    // No-op: SessionManager handles message persistence in the legacy flow
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    // Pass-through: the existing sanitize -> validate -> limit -> repair pipeline
    // in attempt.ts handles context assembly for the legacy engine.
    // We just return the messages as-is with a rough token estimate.
    return {
      messages: params.messages,
      estimatedTokens: 0, // Caller handles estimation
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void> {
    // Skip when there is no budget to evaluate against.
    if (!params.tokenBudget || params.tokenBudget <= 0) {
      return;
    }

    // Skip for heartbeat sessions — they are short-lived.
    if (params.isHeartbeat) {
      return;
    }

    // Resolve the proactive threshold from config (carried in runtimeContext).
    const config = params.runtimeContext?.config as OpenClawConfig | undefined;
    const threshold =
      config?.agents?.defaults?.compaction?.proactiveThreshold ?? DEFAULT_PROACTIVE_THRESHOLD;

    if (threshold <= 0 || threshold > 1) {
      return;
    }

    const estimatedTokens = estimateMessagesTokens(params.messages);
    const thresholdTokens = Math.floor(params.tokenBudget * threshold);

    if (estimatedTokens <= thresholdTokens) {
      return;
    }

    log.info(
      `[proactive-compaction] triggering: estimatedTokens=${estimatedTokens} ` +
        `thresholdTokens=${thresholdTokens} (${(threshold * 100).toFixed(0)}% of ${params.tokenBudget}) ` +
        `sessionId=${params.sessionId}`,
    );

    try {
      const result = await this.compact({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        tokenBudget: params.tokenBudget,
        currentTokenCount: estimatedTokens,
        runtimeContext: {
          ...params.runtimeContext,
          trigger: "proactive",
        },
      });

      if (result.compacted) {
        log.info(
          `[proactive-compaction] completed: tokensBefore=${result.result?.tokensBefore ?? "?"} ` +
            `tokensAfter=${result.result?.tokensAfter ?? "?"} sessionId=${params.sessionId}`,
        );
      } else {
        log.info(
          `[proactive-compaction] skipped: reason=${result.reason ?? "unknown"} ` +
            `sessionId=${params.sessionId}`,
        );
      }
    } catch (err) {
      // Proactive compaction is best-effort; never fail the parent turn.
      log.warn(
        `[proactive-compaction] failed: ${err instanceof Error ? err.message : String(err)} ` +
          `sessionId=${params.sessionId}`,
      );
    }
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult> {
    // Import through a dedicated runtime boundary so the lazy edge remains effective.
    const { compactEmbeddedPiSessionDirect } =
      await import("../agents/pi-embedded-runner/compact.runtime.js");

    // runtimeContext carries the full CompactEmbeddedPiSessionParams fields
    // set by the caller in run.ts. We spread them and override the fields
    // that come from the ContextEngine compact() signature directly.
    const runtimeContext = params.runtimeContext ?? {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridge runtimeContext matches CompactEmbeddedPiSessionParams
    const result = await compactEmbeddedPiSessionDirect({
      ...runtimeContext,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      tokenBudget: params.tokenBudget,
      force: params.force,
      customInstructions: params.customInstructions,
      workspaceDir: (runtimeContext.workspaceDir as string) ?? process.cwd(),
    } as Parameters<typeof compactEmbeddedPiSessionDirect>[0]);

    return {
      ok: result.ok,
      compacted: result.compacted,
      reason: result.reason,
      result: result.result
        ? {
            summary: result.result.summary,
            firstKeptEntryId: result.result.firstKeptEntryId,
            tokensBefore: result.result.tokensBefore,
            tokensAfter: result.result.tokensAfter,
            details: result.result.details,
          }
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    // Nothing to clean up for legacy engine
  }
}

export function registerLegacyContextEngine(): void {
  registerContextEngine("legacy", () => new LegacyContextEngine());
}
