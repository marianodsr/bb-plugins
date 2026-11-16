// Shown when credentials are missing, or when Jira refuses the connection.
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "../components/ui/button";
import { Icon } from "../components/ui/icon";
import { EmptyState } from "../kit";
import { cn } from "../lib/utils";
import type { StatusResult } from "../src/schemas";
import { failureCopy } from "./logic";
import { useCheckConnection } from "./rpc";

export const SETTINGS_ROUTE = "/settings/plugins/jira-viewer";

const STEPS: { field: "site" | "email" | "apiToken"; title: string; detail: string }[] = [
  { field: "site", title: "Jira site", detail: "Your Jira Cloud address, such as acme.atlassian.net." },
  { field: "email", title: "Account email", detail: "The email of the Atlassian account you sign in with." },
  {
    field: "apiToken",
    title: "API token",
    detail: "Create one at id.atlassian.com under Security, API tokens. It is stored on the bb server only.",
  },
];

export function SetupState({ status }: { status: StatusResult }) {
  const check = useCheckConnection();
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[44ch] flex-col gap-5 px-4 py-10">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Connect Jira</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Jira Viewer reads issues from your Jira Cloud site. It never changes them.
          </p>
        </div>
        <ol className="flex flex-col gap-3">
          {STEPS.map((step, index) => {
            const done = !status.missing.includes(step.field);
            return (
              <li key={step.field} className="flex gap-3">
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
                    done ? "bg-success/15 text-foreground" : "border border-border text-muted-foreground",
                  )}
                >
                  {done ? <Icon name="Check" className="size-3" /> : index + 1}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {step.title}
                    {done ? <span className="sr-only"> (set)</span> : null}
                  </span>
                  <span className="text-xs leading-5 text-muted-foreground">{step.detail}</span>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm">
            <UrlLink href={SETTINGS_ROUTE}>Open settings</UrlLink>
          </Button>
          {status.missing.length === 0 ? (
            <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => void check.mutate(null)}>
              {check.isPending ? "Checking" : "Check connection"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Jira refuses the whole connection (bad token, unreachable, not Jira). */
export function ConnectionError({ status }: { status: StatusResult }) {
  const check = useCheckConnection();
  const copy = failureCopy(status.error!);
  return (
    <EmptyState
      tone="error"
      icon="AlertCircle"
      title={copy.title}
      description={copy.description}
      action={
        <div className="flex flex-wrap gap-2">
          {copy.action === "settings" ? (
            <Button asChild size="sm" variant="outline">
              <UrlLink href={SETTINGS_ROUTE}>Open settings</UrlLink>
            </Button>
          ) : null}
          <Button size="sm" variant={copy.action === "settings" ? "ghost" : "outline"} disabled={check.isPending} onClick={() => void check.mutate(null)}>
            {check.isPending ? "Checking" : "Check connection"}
          </Button>
        </div>
      }
      className="py-16"
    />
  );
}
