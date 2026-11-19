// Compact adaptation of the current BB scaffold's Radix dialog pattern.
import * as React from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { Button } from "./button";
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  name,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  name: string;
  busy: boolean;
  error?: string;
  onConfirm(confirmation: string): void;
}) {
  const [confirmation, setConfirmation] = React.useState("");
  React.useEffect(() => {
    setConfirmation("");
  }, [open, name]);
  const scope = usePortalScopeProps();
  return (
    <Primitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay
          {...scope}
          className="fixed inset-0 z-50 bg-black/40"
        />
        <Primitive.Content
          {...scope}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg max-h-[90dvh] overflow-auto"
        >
          <Primitive.Title className="text-lg font-semibold">
            {title}
          </Primitive.Title>
          <Primitive.Description className="mt-2 text-sm text-muted-foreground">
            {description}
          </Primitive.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmation === name && !busy) onConfirm(confirmation);
            }}
            className="mt-4 space-y-4"
          >
            <label className="block text-sm">
              Type <strong className="break-all">{name}</strong> to confirm
              <input
                autoComplete="off"
                aria-label="Confirmation name"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                disabled={busy}
                className="mt-2 h-10 w-full rounded-md border border-input bg-transparent px-3"
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={busy || confirmation !== name}
              >
                {busy ? "Working…" : "Confirm removal"}
              </Button>
            </div>
          </form>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function ReviewDialog({
  open,
  onOpenChange,
  title,
  description,
  busy,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const scope = usePortalScopeProps();
  return (
    <Primitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay
          {...scope}
          className="fixed inset-0 z-50 bg-black/40"
        />
        <Primitive.Content
          {...scope}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-lg max-h-[90dvh] overflow-auto"
        >
          <Primitive.Title className="text-lg font-semibold break-all">
            {title}
          </Primitive.Title>
          <Primitive.Description className="mt-2 text-sm text-muted-foreground">
            {description}
          </Primitive.Description>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
