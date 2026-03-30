/**
 * Slack exec approval adapter — Block Kit buttons for approve/deny.
 *
 * Replaces the broken text-based `/approve` flow (Slack intercepts `/` as
 * a native slash command) with native interactive buttons.
 */

import {
  getExecApprovalReplyMetadata,
  resolveExecApprovalCommandDisplay,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  type PluginApprovalRequest,
  type PluginApprovalResolved,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

// ---------------------------------------------------------------------------
// Action ID encoding
// ---------------------------------------------------------------------------

export const SLACK_EXEC_APPROVAL_ACTION_PREFIX = "openclaw:exec_approval:";

export function buildSlackExecApprovalActionId(
  approvalId: string,
  decision: ExecApprovalDecision,
): string {
  return `${SLACK_EXEC_APPROVAL_ACTION_PREFIX}${encodeURIComponent(approvalId)}:${decision}`;
}

export function parseSlackExecApprovalActionId(
  actionId: string,
): { approvalId: string; decision: ExecApprovalDecision } | null {
  if (!actionId.startsWith(SLACK_EXEC_APPROVAL_ACTION_PREFIX)) {
    return null;
  }
  const rest = actionId.slice(SLACK_EXEC_APPROVAL_ACTION_PREFIX.length);
  const colonIdx = rest.lastIndexOf(":");
  if (colonIdx < 0) {
    return null;
  }
  const approvalId = decodeURIComponent(rest.slice(0, colonIdx));
  const decision = rest.slice(colonIdx + 1) as ExecApprovalDecision;
  if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
    return null;
  }
  return { approvalId, decision };
}

export function isSlackExecApprovalActionId(actionId: string): boolean {
  return actionId.startsWith(SLACK_EXEC_APPROVAL_ACTION_PREFIX);
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function escapeCodeBlock(text: string): string {
  return text.replace(/`/g, "\u200b`");
}

function buildApprovalBlocks(params: {
  title: string;
  commandPreview: string;
  metadataLines: string[];
  approvalId: string;
  expiresText?: string;
  showButtons: boolean;
}): unknown[] {
  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: params.title, emoji: true },
  });

  // Command preview
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Command:*\n\`\`\`${escapeCodeBlock(params.commandPreview)}\`\`\``,
    },
  });

  // Metadata
  if (params.metadataLines.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: params.metadataLines.join("\n") },
    });
  }

  // Buttons
  if (params.showButtons) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve (once)", emoji: true },
          style: "primary",
          action_id: buildSlackExecApprovalActionId(params.approvalId, "allow-once"),
          value: params.approvalId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Always allow", emoji: true },
          action_id: buildSlackExecApprovalActionId(params.approvalId, "allow-always"),
          value: params.approvalId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny", emoji: true },
          style: "danger",
          action_id: buildSlackExecApprovalActionId(params.approvalId, "deny"),
          value: params.approvalId,
        },
      ],
    });
  }

  // Footer context
  if (params.expiresText) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: params.expiresText }],
    });
  }

  return blocks;
}

function buildExecMetadataLines(request: ExecApprovalRequest): string[] {
  const lines: string[] = [];
  if (request.request.agentId) {
    lines.push(`*Agent:* ${request.request.agentId}`);
  }
  if (request.request.host) {
    lines.push(`*Host:* ${request.request.host}`);
  }
  return lines;
}

function formatExpiresIn(expiresAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - nowMs) / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Adapter hooks
// ---------------------------------------------------------------------------

function buildPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: {
    channel: string;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
  };
  nowMs: number;
}): ReplyPayload | null {
  const { commandText } = resolveExecApprovalCommandDisplay(params.request.request);
  const commandPreview = truncate(commandText, 800);
  const metadataLines = buildExecMetadataLines(params.request);
  const expiresText = `Expires in ${formatExpiresIn(params.request.expiresAtMs, params.nowMs)} · ID: ${params.request.id.slice(0, 8)}`;

  const blocks = buildApprovalBlocks({
    title: "Exec Approval Required",
    commandPreview,
    metadataLines,
    approvalId: params.request.id,
    expiresText,
    showButtons: true,
  });

  return {
    text: `Exec approval required: ${commandPreview}`,
    channelData: {
      slack: { blocks },
      execApproval: {
        approvalId: params.request.id,
        approvalSlug: params.request.id.slice(0, 8),
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
  };
}

function buildResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: ExecApprovalResolved;
  target: {
    channel: string;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
  };
}): ReplyPayload | null {
  const decisionLabel =
    params.resolved.decision === "allow-once"
      ? "Allowed (once)"
      : params.resolved.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const emoji = params.resolved.decision === "deny" ? ":no_entry:" : ":white_check_mark:";

  const resolvedBy = params.resolved.resolvedBy ? ` by ${params.resolved.resolvedBy}` : "";

  const text = `${emoji} Exec approval *${decisionLabel}*${resolvedBy}. ID: ${params.resolved.id.slice(0, 8)}`;

  return { text };
}

function buildPluginPendingPayload(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  target: {
    channel: string;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
  };
  nowMs: number;
}): ReplyPayload | null {
  const title = truncate(params.request.request.title, 800);
  const metadataLines: string[] = [];
  if (params.request.request.pluginId) {
    metadataLines.push(`*Plugin:* ${params.request.request.pluginId}`);
  }
  if (params.request.request.agentId) {
    metadataLines.push(`*Agent:* ${params.request.request.agentId}`);
  }
  const expiresText = `Expires in ${formatExpiresIn(params.request.expiresAtMs, params.nowMs)} · ID: ${params.request.id.slice(0, 8)}`;

  const blocks = buildApprovalBlocks({
    title: "Plugin Approval Required",
    commandPreview: title,
    metadataLines,
    approvalId: params.request.id,
    expiresText,
    showButtons: true,
  });

  return {
    text: `Plugin approval required: ${title}`,
    channelData: {
      slack: { blocks },
      execApproval: {
        approvalId: params.request.id,
        approvalSlug: params.request.id.slice(0, 8),
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    },
  };
}

function buildPluginResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: PluginApprovalResolved;
  target: {
    channel: string;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
  };
}): ReplyPayload | null {
  const decisionLabel =
    params.resolved.decision === "allow-once"
      ? "Allowed (once)"
      : params.resolved.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";

  const emoji = params.resolved.decision === "deny" ? ":no_entry:" : ":white_check_mark:";

  const resolvedBy = params.resolved.resolvedBy ? ` by ${params.resolved.resolvedBy}` : "";

  return {
    text: `${emoji} Plugin approval *${decisionLabel}*${resolvedBy}. ID: ${params.resolved.id.slice(0, 8)}`,
  };
}

function shouldSuppressLocalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return getExecApprovalReplyMetadata(params.payload) !== null;
}

function getInitiatingSurfaceState(_params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { kind: "enabled" } | { kind: "disabled" } | { kind: "unsupported" } {
  return { kind: "enabled" };
}

// ---------------------------------------------------------------------------
// Exported adapter
// ---------------------------------------------------------------------------

export const slackExecApprovalAdapter = {
  getInitiatingSurfaceState,
  shouldSuppressLocalPrompt,
  buildPendingPayload,
  buildResolvedPayload,
  buildPluginPendingPayload,
  buildPluginResolvedPayload,
};
