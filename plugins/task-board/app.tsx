// Task Board frontend: the board page, the task panel beside it, the nav
// badge, the thread context card row and palette commands.
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS as SEGMENT_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS,
  experimental_useRpcQuery,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";
import { rpcContract, type RpcContract } from "./src/contract";
import { BoardPage } from "./ui/Page";
import { BoardHeader } from "./ui/Header";
import { TaskPanel } from "./ui/Detail";
import { TaskContextRow, TaskContextSegment, useTaskSegmentVisible } from "./ui/ContextRow";
import { COMMANDS, setCommandHandles } from "./ui/commands";
import { BOARD_PANEL_ID, TASK_TAB } from "./ui/tabs";

/** Tasks waiting in Review, across every board. bb keeps this hook mounted. */
function useReviewBadge() {
  const navigate = useBbNavigate();
  const rpc = useRpc<RpcContract>();
  useEffect(() => setCommandHandles({ navigate, rpc }), [navigate, rpc]);
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: null });
  const count = data?.reviewCount ?? 0;
  return count > 0 ? { count, label: `${count} task${count === 1 ? "" : "s"} in review` } : null;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: BOARD_PANEL_ID,
    title: "Task Board",
    icon: "ListTodo",
    path: "board",
    component: BoardPage,
    headerContent: BoardHeader,
    experimental_useBadge: useReviewBadge,
  });
  app.slots.experimental_tab({
    ...TASK_TAB,
    title: "Task",
    icon: "ListTodo",
    layout: "flush",
    component: TaskPanel,
  });
  app.slots.experimental_threadContextCardRow({
    id: "task",
    group: ROW_GROUPS.thread,
    order: 50,
    component: TaskContextRow,
  });
  app.slots.experimental_threadContextSegment({
    id: "task",
    title: "Task",
    group: SEGMENT_GROUPS.thread,
    order: 50,
    summary: TaskContextSegment,
    useVisible: useTaskSegmentVisible,
  });
  for (const command of COMMANDS) app.commands.register(command);
});
