// Lane management: rename, change kind, reorder and delete a lane, or add one.
import { useState, type FormEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Segmented, useKitMotion } from "../kit";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { rpcContract } from "../src/contract";
import type { LaneKind } from "../src/schemas";
import { boardInput, failureText } from "./data";
import { KIND_NAMES, type BoardData } from "./model";

const KIND_OPTIONS = (["todo", "doing", "review", "done"] as const).map((kind) => ({
  value: kind,
  label: KIND_NAMES[kind].replace("In progress", "Doing"),
  title: `Counts as ${KIND_NAMES[kind]}`,
}));

const fieldClass =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

export function LaneMenu({
  board,
  laneId,
  projectId: projectIdProp,
}: {
  board: BoardData;
  /** null: the "Add lane" control at the end of the board. */
  laneId: string | null;
  projectId?: string;
}) {
  const portal = usePortalScopeProps();
  const { variants } = useKitMotion();
  const [open, setOpen] = useState(false);
  const lane = laneId ? board.lanes.find((row) => row.id === laneId) ?? null : null;
  const projectId = lane?.projectId ?? projectIdProp!;
  const input = boardInput(projectId);
  const lanes = board.lanes.filter((row) => row.projectId === projectId);
  const index = lane ? lanes.findIndex((row) => row.id === lane.id) : -1;

  const [name, setName] = useState(lane?.name ?? "");
  const [kind, setKind] = useState<LaneKind>(lane?.kind ?? "doing");
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState<string>("");

  const update = experimental_useRpcMutation({
    contract: rpcContract,
    method: "updateLane",
    optimistic(write, cache) {
      cache.update("board", input, (current) => ({
        ...current,
        lanes: current.lanes.map((row) =>
          row.id === write.laneId
            ? { ...row, ...(write.name ? { name: write.name } : {}), ...(write.kind ? { kind: write.kind } : {}) }
            : row,
        ),
      }));
    },
  });
  const reorder = experimental_useRpcMutation({
    contract: rpcContract,
    method: "moveLane",
    optimistic(write, cache) {
      cache.update("board", input, (current) => {
        const moving = current.lanes.find((row) => row.id === write.laneId);
        if (!moving) return current;
        const rest = current.lanes.filter((row) => row.id !== write.laneId);
        const at = write.afterLaneId === null ? 0 : rest.findIndex((row) => row.id === write.afterLaneId) + 1;
        return { ...current, lanes: [...rest.slice(0, at), moving, ...rest.slice(at)] };
      });
    },
  });
  const create = experimental_useRpcMutation({ contract: rpcContract, method: "createLane" });
  const remove = experimental_useRpcMutation({ contract: rpcContract, method: "deleteLane" });

  const reset = (next: boolean) => {
    setOpen(next);
    if (next) {
      setName(lane?.name ?? "");
      setKind(lane?.kind ?? "doing");
      setDeleting(false);
      setMoveTo(lanes.find((row) => row.id !== lane?.id)?.id ?? "");
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (lane) {
      if (trimmed !== lane.name || kind !== lane.kind) {
        update
          .mutate({ laneId: lane.id, name: trimmed, kind })
          .catch((error) => toast.error(failureText("Could not save the lane", error)));
      }
      setOpen(false);
      return;
    }
    create
      .mutate({ projectId, name: trimmed, kind, afterLaneId: lanes.at(-1)?.id ?? null })
      .then(() => setOpen(false), (error) => toast.error(failureText("Could not add the lane", error)));
  };

  const shift = (direction: -1 | 1) => {
    if (!lane) return;
    const others = lanes.filter((row) => row.id !== lane.id);
    const target = index + direction;
    if (target < 0 || target > others.length) return;
    const after = target === 0 ? null : others[target - 1]!.id;
    reorder
      .mutate({ laneId: lane.id, afterLaneId: after })
      .catch((error) => toast.error(failureText("Could not move the lane", error)));
  };

  const confirmDelete = () => {
    if (!lane) return;
    remove
      .mutate({ laneId: lane.id, moveTasksTo: lane.taskCount > 0 ? moveTo : null })
      .then(
        () => {
          setOpen(false);
          toast(`Deleted the ${lane.name} lane`);
        },
        (error) => toast.error(failureText("Could not delete the lane", error)),
      );
  };

  const trigger = lane ? (
    <button
      type="button"
      aria-label={`${lane.name} lane options`}
      title="Lane options"
      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active"
    >
      <Icon name="Settings" className="size-3.5" aria-hidden />
    </button>
  ) : (
    <button
      type="button"
      className="flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-state-active"
    >
      <Icon name="Plus" className="size-3.5" aria-hidden />
      Add lane
    </button>
  );

  return (
    <Popover.Root open={open} onOpenChange={reset}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <AnimatePresence>
        {open ? (
          <Popover.Portal forceMount>
            <Popover.Content {...portal} forceMount asChild align="end" sideOffset={6} collisionPadding={12}>
              <motion.div
                variants={variants.fadeScale}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
                className="z-50 w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
              >
                {deleting && lane ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm font-medium">Delete the {lane.name} lane?</p>
                    {lane.taskCount > 0 ? (
                      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                        Move its {lane.taskCount} {lane.taskCount === 1 ? "task" : "tasks"} to
                        <select value={moveTo} onChange={(event) => setMoveTo(event.target.value)} className={fieldClass}>
                          {lanes
                            .filter((row) => row.id !== lane.id)
                            .map((row) => (
                              <option key={row.id} value={row.id}>
                                {row.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    ) : (
                      <p className="text-xs text-muted-foreground">The lane is empty.</p>
                    )}
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(false)}>
                        Keep lane
                      </Button>
                      <Button size="sm" variant="destructive" onClick={confirmDelete} disabled={remove.isPending}>
                        Delete lane
                      </Button>
                    </div>
                  </div>
                ) : (
                  <form onSubmit={save} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      Name
                      <input
                        autoFocus
                        value={name}
                        maxLength={40}
                        onChange={(event) => setName(event.target.value)}
                        className={fieldClass}
                        placeholder="Lane name"
                      />
                    </label>
                    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                      Counts as
                      <Segmented aria-label="Lane kind" value={kind} onChange={setKind} options={KIND_OPTIONS} />
                    </div>
                    <div className="flex items-center gap-1">
                      {lane ? (
                        <>
                          <Button type="button" size="sm" variant="ghost" disabled={index <= 0} onClick={() => shift(-1)}>
                            Move left
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={index >= lanes.length - 1}
                            onClick={() => shift(1)}
                          >
                            Move right
                          </Button>
                        </>
                      ) : null}
                      <span className="flex-1" />
                      <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
                        {lane ? "Save" : "Add lane"}
                      </Button>
                    </div>
                    {lane ? (
                      <button
                        type="button"
                        onClick={() => setDeleting(true)}
                        disabled={lanes.length <= 1}
                        className={cn(
                          "self-start rounded-md text-xs text-destructive-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          "disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline",
                        )}
                      >
                        {lanes.length <= 1 ? "A board needs at least one lane" : "Delete lane"}
                      </button>
                    ) : null}
                  </form>
                )}
              </motion.div>
            </Popover.Content>
          </Popover.Portal>
        ) : null}
      </AnimatePresence>
    </Popover.Root>
  );
}
