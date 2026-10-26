import { t } from "@openfield/core";

// What's wrong with an imported canvas document, in words a person can act on (§7.8). The web
// app's file import and the server's archive import both say it the same way.

export interface DocumentIssue {
  /** zod's kind of problem. Only "custom" ones (the document's own checks) carry our words. */
  code?: string;
  path: readonly PropertyKey[];
  message: string;
}

export const hasIssues = (error: unknown): error is { issues: DocumentIssue[] } =>
  typeof error === "object" && error !== null && Array.isArray((error as { issues?: unknown }).issues);

/**
 * "Node 3: …" for the first problem, so the person can find it in the file. zod's own wording
 * ("Too big: expected number to be <=4") never reaches them: without words of ours, it says which
 * node can't be read.
 */
export function describeIssue(issue: DocumentIssue): string {
  const [list, index] = issue.path;
  const message = !issue.code || issue.code === "custom" ? issue.message : null;
  if (typeof index === "number") {
    const at = index + 1;
    if (list === "nodes")
      return message
        ? t("canvas.index.import.node", { index: at, message })
        : t("canvas.index.import.nodeUnreadable", { index: at });
    if (list === "edges")
      return message
        ? t("canvas.index.import.connection", { index: at, message })
        : t("canvas.index.import.connectionUnreadable", { index: at });
  }
  return message ?? t("canvas.index.import.notCanvas");
}
