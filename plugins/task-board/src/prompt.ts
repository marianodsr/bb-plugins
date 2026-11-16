// The prompt a "Start work" handoff delivers. Shared by the server's
// taskPrompt RPC and the app's handoff preview, so both say the same thing.
import type { ExternalRef } from "./schemas";

export function buildTaskPrompt(task: {
  id: string;
  title: string;
  body: string;
  externalRef: ExternalRef | null;
}): string {
  const lines = [`Work on this task from the Task Board: ${task.title}`];
  if (task.externalRef) lines.push(`Jira: ${task.externalRef.key} (${task.externalRef.url})`);
  if (task.body.trim()) lines.push("", task.body.trim());
  lines.push("", `Task id: ${task.id}. Keep it current with the tasks_ tools.`);
  return lines.join("\n");
}
