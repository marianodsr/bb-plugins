// GENERATED from /kit by kit/scripts/sync.mjs (kit 36f976388355). Do not edit; change /kit and re-sync.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { ShortcutHint } from "./Kbd";

/**
 * Create or edit in place. Enter submits (Shift+Enter is a new line when
 * `multiline`), Escape cancels. With `keepOpen` the field clears and stays
 * focused after a submit, for adding several in a row.
 *
 * Submission is optimistic: the field clears at once and `onSubmit` runs; if
 * it rejects, the text comes back and the error shows under the field.
 *
 * ```tsx
 * <InlineComposer placeholder="Task title" submitLabel="Add task" keepOpen
 *   onSubmit={(title) => createTask({ title })} onCancel={close} />
 * ```
 */
export function InlineComposer({
  onSubmit,
  onCancel,
  placeholder,
  submitLabel = "Add",
  defaultValue = "",
  multiline = false,
  keepOpen = false,
  autoFocus = true,
  className,
  "aria-label": ariaLabel,
}: {
  onSubmit: (value: string) => void | Promise<void>;
  onCancel?: () => void;
  placeholder?: string;
  submitLabel?: string;
  defaultValue?: string;
  multiline?: boolean;
  keepOpen?: boolean;
  autoFocus?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) field.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = value.trim();
    if (!text) return;
    setError(null);
    setValue(keepOpen ? "" : text);
    field.current?.focus();
    Promise.resolve(onSubmit(text)).then(
      () => {
        if (!keepOpen) setValue("");
      },
      (cause: unknown) => {
        setValue(text);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
      return;
    }
    if (event.key === "Enter" && (!multiline || !event.shiftKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        "@container rounded-lg border border-border bg-card p-2 transition-colors duration-[120ms] ease-out focus-within:border-ring/40",
        className,
      )}
    >
      <textarea
        ref={field}
        rows={1}
        value={value}
        aria-label={ariaLabel ?? placeholder}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        className="block max-h-60 w-full resize-none bg-transparent px-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
      />
      {error ? <p className="px-1 pt-1 text-xs text-destructive-text">{error}</p> : null}
      <div className="mt-1.5 flex items-center gap-2">
        <ShortcutHint combo="Enter" label={multiline ? "to save, Shift+Enter for a new line" : "to save"} className="hidden @[22rem]:inline-flex" />
        <span className="flex-1" />
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" size="sm" className="h-7" disabled={!value.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
