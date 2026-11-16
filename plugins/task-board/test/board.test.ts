import { describe, expect, it } from "vitest";
import { boardOf, laneTitles, OTHER_PROJECT, PROJECT, setup } from "./helpers";

describe("board and writes", () => {
  it("creates default lanes on first read without invalidating", async () => {
    const env = await setup();
    const board = await boardOf(env);
    expect(board.lanes.map((lane) => [lane.name, lane.kind])).toEqual([
      ["To do", "todo"],
      ["In progress", "doing"],
      ["Review", "review"],
      ["Done", "done"],
    ]);
    expect(env.invalidations()).toEqual([]);
  });

  it("shows only projects with tasks in the all-projects view", async () => {
    const env = await setup();
    await boardOf(env, OTHER_PROJECT);
    await env.rpc("createTask", { title: "Here", projectId: PROJECT });
    const all = await env.rpc("board", { projectId: null });
    expect(all.projects).toEqual([{ id: PROJECT, name: "Alpha" }]);
    expect(all.lanes).toHaveLength(4);
  });

  it("refuses boards for unknown projects", async () => {
    const env = await setup();
    await expect(env.rpc("board", { projectId: "proj_missing" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("invalidates each write's tags once, whatever the surface", async () => {
    const env = await setup();
    const { id } = await env.rpc("createTask", { title: "One", projectId: PROJECT });
    expect(env.invalidations()).toEqual([["board:all", "summary", `board:${PROJECT}`, `task:${id}`]]);

    await env.harness.behavior.runCli(["comment", id, "from", "cli"], { projectId: PROJECT });
    expect(env.invalidations()).toHaveLength(2);
    expect(env.invalidations()[1]).toEqual(["board:all", "summary", `board:${PROJECT}`, `task:${id}`]);

    // A no-op write changes nothing and invalidates nothing.
    await env.rpc("updateTask", { taskId: id, title: "One" });
    expect(env.invalidations()).toHaveLength(2);
  });

  it("implements the cross-plugin createTask contract", async () => {
    const env = await setup();
    // No projectId: falls back to the first project, then remembers boards read.
    const first = await env.rpc("createTask", { title: "Anywhere" });
    expect(first).toEqual({ id: expect.stringMatching(/^tsk_[a-z0-9]{10}$/u) });
    expect((await env.rpc("task", { taskId: first.id })).task.projectId).toBe(PROJECT);
    await boardOf(env, OTHER_PROJECT);
    const second = await env.rpc("createTask", { title: "Recent board" });
    expect((await env.rpc("task", { taskId: second.id })).task.projectId).toBe(OTHER_PROJECT);

    const ref = { kind: "jira", key: "ENG-42", url: "https://acme.atlassian.net/browse/ENG-42" };
    const fromJira = await env.rpc("createTask", { title: "Jira", body: "From Jira", projectId: PROJECT, externalRef: ref });
    const again = await env.rpc("createTask", { title: "Jira again", projectId: PROJECT, externalRef: ref });
    expect(again.id).toBe(fromJira.id);
    // Without a project, the reference is found on whichever board has it.
    await boardOf(env, OTHER_PROJECT);
    expect((await env.rpc("createTask", { title: "Jira, no project", externalRef: ref })).id).toBe(fromJira.id);
    expect((await env.rpc("task", { taskId: fromJira.id })).task.externalRef).toEqual(ref);

    await expect(
      env.rpc("createTask", { title: "Bad", externalRef: { ...ref, url: "http://insecure" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(env.rpc("createTask", { title: "Bad", extra: true })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts a client-generated id for optimistic creates and refuses duplicates", async () => {
    const env = await setup();
    await env.rpc("createTask", { id: "tsk_aaaaaaaaaa", title: "Mine", projectId: PROJECT, placement: "top" });
    await expect(
      env.rpc("createTask", { id: "tsk_aaaaaaaaaa", title: "Again", projectId: PROJECT }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("records activity for moves and comments with the actor", async () => {
    const env = await setup();
    const board = await boardOf(env);
    const { id } = await env.rpc("createTask", { title: "Track me", projectId: PROJECT });
    const review = board.lanes.find((lane) => lane.kind === "review")!;
    await env.rpc("moveTask", { taskId: id, laneId: review.id });
    await env.rpc("addComment", { taskId: id, body: "Looks good" });
    const { task } = await env.rpc("task", { taskId: id });
    expect(task.events.map((event: { kind: string; actor: string }) => [event.kind, event.actor])).toEqual([
      ["commented", "user"],
      ["moved", "user"],
      ["created", "user"],
    ]);
    expect(task.events[1].payload).toMatchObject({ fromLaneName: "To do", toLaneName: "Review" });
    expect(task.commentCount).toBe(1);
    expect((await env.rpc("summary", null)).reviewCount).toBe(1);
  });

  it("pages lanes and reports the full count", async () => {
    const env = await setup();
    for (let index = 0; index < 5; index += 1) await env.rpc("createTask", { title: `T${index}`, projectId: PROJECT });
    const page = await env.rpc("board", { projectId: PROJECT, perLane: 2 });
    expect(page.tasks.map((task: { title: string }) => task.title)).toEqual(["T0", "T1"]);
    expect(page.truncated).toBe(true);
    expect(page.lanes[0].taskCount).toBe(5);
  });

  it("archives out of the board and restores to the bottom of the lane", async () => {
    const env = await setup();
    const a = await env.rpc("createTask", { title: "A", projectId: PROJECT });
    await env.rpc("createTask", { title: "B", projectId: PROJECT });
    await env.rpc("archiveTask", { taskId: a.id, archived: true });
    let board = await boardOf(env);
    expect(laneTitles(board, board.lanes[0]!.id)).toEqual(["B"]);
    await env.rpc("archiveTask", { taskId: a.id, archived: false });
    board = await boardOf(env);
    expect(laneTitles(board, board.lanes[0]!.id)).toEqual(["B", "A"]);
  });

  it("deletes a task with its links and clears the thread's metadata", async () => {
    const env = await setup();
    env.addThread({ id: "thr_one" });
    const { id } = await env.rpc("createTask", { title: "Doomed", projectId: PROJECT });
    await env.rpc("linkThread", { taskId: id, threadId: "thr_one" });
    expect(env.threads.get("thr_one")!.metadata).toEqual({ taskId: id });
    await env.rpc("deleteTask", { taskId: id });
    expect((await env.rpc("task", { taskId: id })).task).toBeNull();
    expect(env.threads.get("thr_one")!.metadata).toEqual({});
    expect((await env.rpc("taskForThread", { threadId: "thr_one" })).task).toBeNull();
  });

  it("manages lanes and refuses unsafe deletes", async () => {
    const env = await setup();
    const board = await boardOf(env);
    const lane = await env.rpc("createLane", { projectId: PROJECT, name: "QA", kind: "review", afterLaneId: board.lanes[2]!.id });
    let next = await boardOf(env);
    expect(next.lanes.map((row) => row.name)).toEqual(["To do", "In progress", "Review", "QA", "Done"]);
    await env.rpc("moveLane", { laneId: lane.id, afterLaneId: null });
    next = await boardOf(env);
    expect(next.lanes[0]!.name).toBe("QA");
    const { id } = await env.rpc("createTask", { title: "In QA", projectId: PROJECT, laneId: lane.id });
    await expect(env.rpc("deleteLane", { laneId: lane.id })).rejects.toMatchObject({ code: "conflict" });
    await env.rpc("deleteLane", { laneId: lane.id, moveTasksTo: board.lanes[0]!.id });
    expect((await env.rpc("task", { taskId: id })).task.laneName).toBe("To do");
  });
});

describe("ordering under concurrent moves", () => {
  async function seededLane(env: Awaited<ReturnType<typeof setup>>, titles: string[]) {
    const ids: Record<string, string> = {};
    for (const title of titles) ids[title] = (await env.rpc("createTask", { title, projectId: PROJECT })).id;
    return ids;
  }

  it("moves within and across lanes by naming neighbours", async () => {
    const env = await setup();
    const ids = await seededLane(env, ["A", "B", "C", "D"]);
    const board = await boardOf(env);
    const todo = board.lanes[0]!.id;
    const doing = board.lanes[1]!.id;
    await env.rpc("moveTask", { taskId: ids.D, laneId: todo, afterTaskId: ids.A });
    expect(laneTitles(await boardOf(env), todo)).toEqual(["A", "D", "B", "C"]);
    await env.rpc("moveTask", { taskId: ids.A, laneId: todo, beforeTaskId: ids.C });
    expect(laneTitles(await boardOf(env), todo)).toEqual(["D", "B", "A", "C"]);
    await env.rpc("moveTask", { taskId: ids.B, laneId: doing });
    await env.rpc("moveTask", { taskId: ids.C, laneId: doing, beforeTaskId: ids.B });
    const after = await boardOf(env);
    expect(laneTitles(after, todo)).toEqual(["D", "A"]);
    expect(laneTitles(after, doing)).toEqual(["C", "B"]);
  });

  it("writes only the moved row", async () => {
    const env = await setup();
    const ids = await seededLane(env, ["A", "B", "C", "D", "E"]);
    const before = await boardOf(env);
    await env.rpc("moveTask", { taskId: ids.E, laneId: before.lanes[0]!.id, afterTaskId: ids.A });
    const after = await boardOf(env);
    const positions = (board: typeof before) => new Map(board.tasks.map((task) => [task.id, task.position]));
    const changed = [...positions(after)].filter(([id, position]) => positions(before).get(id) !== position);
    expect(changed.map(([id]) => id)).toEqual([ids.E]);
  });

  it("interleaves a user drag and an agent move made from the same stale view", async () => {
    const env = await setup();
    const ids = await seededLane(env, ["A", "B", "C"]);
    const board = await boardOf(env);
    const todo = board.lanes[0]!.id;
    const review = board.lanes[2]!.id;
    env.addThread({ id: "thr_agent" });
    await env.rpc("linkThread", { taskId: ids.C, threadId: "thr_agent" });

    // Both saw [A, B, C]. The user drops C between A and B; the agent, at the
    // same moment, moves C to review. Then the user drops B after C (which is
    // no longer in to-do), using the stale view again.
    await env.rpc("moveTask", { taskId: ids.C, laneId: todo, afterTaskId: ids.A, beforeTaskId: ids.B });
    await env.harness.behavior.callAgentTool("tasks_move", { lane: "review" }, { threadId: "thr_agent", projectId: PROJECT });
    await env.rpc("moveTask", { taskId: ids.B, laneId: todo, afterTaskId: ids.C, beforeTaskId: null });

    const after = await boardOf(env);
    expect(laneTitles(after, todo)).toEqual(["A", "B"]);
    expect(laneTitles(after, review)).toEqual(["C"]);
    const { task } = await env.rpc("task", { taskId: ids.C });
    expect(task.updatedBy).toBe("agent");
    expect(task.events[0]).toMatchObject({ kind: "moved", actor: "agent", actorThreadId: "thr_agent" });
  });

  it("keeps a consistent order when many clients insert at the same gap", async () => {
    const env = await setup();
    const ids = await seededLane(env, ["A", "Z"]);
    const board = await boardOf(env);
    const todo = board.lanes[0]!.id;
    // Ten writers all think the gap is between A and Z and drop after A.
    const movers: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const { id } = await env.rpc("createTask", { title: `M${index}`, projectId: PROJECT, laneId: board.lanes[1]!.id });
      movers.push(id);
    }
    await Promise.all(
      movers.map((taskId) => env.rpc("moveTask", { taskId, laneId: todo, afterTaskId: ids.A, beforeTaskId: ids.Z })),
    );
    const after = await boardOf(env);
    const lane = after.tasks.filter((task) => task.laneId === todo);
    expect(lane[0]!.title).toBe("A");
    expect(lane.at(-1)!.title).toBe("Z");
    expect(lane).toHaveLength(12);
    const positions = lane.map((task) => task.position);
    expect(new Set(positions).size).toBe(12);
    expect(positions).toEqual(positions.slice().sort());
  });

  it("falls back when both anchors left the lane", async () => {
    const env = await setup();
    const ids = await seededLane(env, ["A", "B", "C"]);
    const board = await boardOf(env);
    const todo = board.lanes[0]!.id;
    const done = board.lanes[3]!.id;
    await env.rpc("moveTask", { taskId: ids.A, laneId: done });
    await env.rpc("moveTask", { taskId: ids.B, laneId: done });
    await env.rpc("moveTask", { taskId: ids.C, laneId: todo, afterTaskId: ids.A, beforeTaskId: ids.B, placement: "top" });
    expect(laneTitles(await boardOf(env), todo)).toEqual(["C"]);
  });

  it("refuses moves to another project's lane", async () => {
    const env = await setup();
    const { id } = await env.rpc("createTask", { title: "Here", projectId: PROJECT });
    const other = await boardOf(env, OTHER_PROJECT);
    await expect(env.rpc("moveTask", { taskId: id, laneId: other.lanes[0]!.id })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("start work and lane creation", () => {
  it("links and moves a to-do card to the first doing lane in one write", async () => {
    const env = await setup();
    env.addThread({ id: "thr_go" });
    const { id } = await env.rpc("createTask", { title: "Go", projectId: PROJECT });
    const before = env.invalidations().length;
    expect(await env.rpc("startWork", { taskId: id, threadId: "thr_go" })).toEqual({ moved: true });
    expect(env.invalidations().length).toBe(before + 1);
    const { task } = await env.rpc("task", { taskId: id });
    expect(task.laneKind).toBe("doing");
    expect(task.threadIds).toEqual(["thr_go"]);
    expect(env.threads.get("thr_go")!.metadata).toEqual({ taskId: id });
    // A card already past to-do stays where it is.
    const board = await boardOf(env);
    await env.rpc("moveTask", { taskId: id, laneId: board.lanes[2]!.id });
    env.addThread({ id: "thr_two" });
    expect(await env.rpc("startWork", { taskId: id, threadId: "thr_two" })).toEqual({ moved: false });
    expect((await env.rpc("task", { taskId: id })).task.laneKind).toBe("review");
  });

  it("creates lanes only when a board is opened or a task created", async () => {
    const env = await setup();
    const lanes = await env.harness.behavior.runCli(["lanes"], { projectId: OTHER_PROJECT });
    expect(lanes.stdout).toContain("no board yet");
    await env.harness.behavior.callAgentTool("tasks_list", {}, { threadId: "thr_a", projectId: OTHER_PROJECT });
    await env.rpc("board", { projectId: null });
    expect((await env.harness.behavior.runCli(["lanes", "--json"], { projectId: OTHER_PROJECT })).stdout.trim()).toBe("[]");
    await boardOf(env, OTHER_PROJECT);
    expect(JSON.parse((await env.harness.behavior.runCli(["lanes", "--json"], { projectId: OTHER_PROJECT })).stdout)).toHaveLength(4);
  });
});
