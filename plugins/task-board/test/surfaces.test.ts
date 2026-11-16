import { describe, expect, it } from "vitest";
import { OTHER_PROJECT, PROJECT, setup } from "./helpers";

function text(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.map((part) => part.text).join("\n");
}

describe("bb tasks CLI", () => {
  it("creates, lists in pages, moves with a comment and shows bounded output", async () => {
    const env = await setup();
    const cli = (argv: string[], threadId?: string) =>
      env.harness.behavior.runCli(argv, { projectId: PROJECT, ...(threadId ? { threadId } : {}) });

    const created = await cli(["create", "Big task", "--body", "x".repeat(6_000), "--label", "a,b", "--priority", "high", "--json"]);
    expect(created.exitCode).toBe(0);
    const id = JSON.parse(created.stdout).id as string;
    for (let index = 0; index < 4; index += 1) await cli(["create", `Small ${index}`]);

    const page = await cli(["list", "--limit", "2"]);
    expect(page.stdout).toContain("Showing 1-2 of 5.");
    expect(page.stdout).toContain("bb tasks list --offset 2");

    const moved = await cli(["move", id, "review", "--comment", "Ready: run the tests"], "thr_agent");
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("[Review]");

    const shown = await cli(["show", id]);
    expect(shown.stdout).toContain("2000 more characters (use --full)");
    expect(shown.stdout).toContain("agent (thr_agent)  commented: Ready: run the tests");
    expect(shown.stdout).toContain("moved To do → Review");
    expect((await cli(["show", id, "--full"])).stdout).not.toContain("more characters");

    expect((await cli(["list", "--lane", "review"])).stdout).toContain("Big task");
  });

  it("fails with codes and hints agents can act on", async () => {
    const env = await setup();
    const noProject = await env.harness.behavior.runCli(["list"]);
    expect(noProject.exitCode).not.toBe(0);
    expect(noProject.stderr).toContain("--project");

    const badId = await env.harness.behavior.runCli(["show", "nope"], { projectId: PROJECT });
    expect(badId.stderr).toContain("tsk_");

    const { id } = await env.rpc("createTask", { title: "A", projectId: PROJECT });
    const badLane = await env.harness.behavior.runCli(["move", id, "limbo", "--json"], { projectId: PROJECT });
    expect(JSON.parse(badLane.stdout)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(badLane.stderr).toContain('"Review" (review)');
  });

  it("links the current thread and reports it", async () => {
    const env = await setup();
    env.addThread({ id: "thr_cli" });
    const { id } = await env.rpc("createTask", { title: "Linkable", projectId: PROJECT });
    const linked = await env.harness.behavior.runCli(["link", id], { projectId: PROJECT, threadId: "thr_cli" });
    expect(linked.stdout).toContain(`Linked thr_cli to ${id}`);
    const current = await env.harness.behavior.runCli(["current"], { projectId: PROJECT, threadId: "thr_cli" });
    expect(current.stdout).toContain("Linkable");
    expect(current.stdout).toContain("thr_cli  idle");
  });
});

describe("tasks_ tools", () => {
  it("default to the linked task and leave a note while moving to review", async () => {
    const env = await setup();
    env.addThread({ id: "thr_agent", status: "active", displayStatus: "active" });
    const { id } = await env.rpc("createTask", { title: "Agent work", projectId: PROJECT });
    await env.rpc("linkThread", { taskId: id, threadId: "thr_agent" });
    const ctx = { threadId: "thr_agent", projectId: PROJECT };

    expect(text(await env.harness.behavior.callAgentTool("tasks_get", {}, ctx))).toContain("thr_agent  running");
    await env.harness.behavior.callAgentTool("tasks_move", { lane: "doing" }, ctx);
    const moved = text(
      await env.harness.behavior.callAgentTool("tasks_move", { lane: "review", comment: "Done; see the diff" }, ctx),
    );
    expect(moved).toContain("[Review]");
    // The result is read after the comment is saved.
    expect(moved).toContain("1 comment");
    const { task } = await env.rpc("task", { taskId: id });
    expect(task.laneKind).toBe("review");
    expect(task.events[0]).toMatchObject({ kind: "commented", actor: "agent", payload: { body: "Done; see the diff" } });

    await env.harness.behavior.callAgentTool("tasks_comment", { body: "One more note" }, ctx);
    await env.harness.behavior.callAgentTool("tasks_update", { priority: "urgent" }, ctx);
    expect((await env.rpc("task", { taskId: id })).task.priority).toBe("urgent");
    const listed = text(await env.harness.behavior.callAgentTool("tasks_list", { lane: "review" }, ctx));
    expect(listed).toContain("Agent work");
    const created = text(await env.harness.behavior.callAgentTool("tasks_create", { title: "Follow-up", lane: "todo" }, ctx));
    expect(created).toMatch(/Created tsk_[a-z0-9]{10}  \[To do\]  Follow-up/u);
  });

  it("stay inside the thread's project and explain an unlinked thread", async () => {
    const env = await setup();
    const far = await env.rpc("createTask", { title: "Far", projectId: OTHER_PROJECT });
    const ctx = { threadId: "thr_lonely", projectId: PROJECT };
    const unlinked = await env.harness.behavior.callAgentTool("tasks_move", { lane: "review" }, ctx);
    expect(unlinked).toMatchObject({ isError: true });
    expect(text(unlinked)).toContain("not linked");
    const cross = await env.harness.behavior.callAgentTool("tasks_comment", { taskId: far.id, body: "hi" }, ctx);
    expect(text(cross)).toContain("another project");
    expect((await env.rpc("task", { taskId: far.id })).task.commentCount).toBe(0);
  });
});
