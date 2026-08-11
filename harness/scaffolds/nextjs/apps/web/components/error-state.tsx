export function ErrorState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="rounded-md border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  );
}
