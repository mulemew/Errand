import { Link2 } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useLang } from "@/contexts/lang-context";

/** A task holding a reference to a provider / proxy / fingerprint. */
export interface TaskRef {
  id: number;
  name: string;
}

/**
 * "Used by N tasks", with the names one click away.
 *
 * The three pages that own a shared resource — providers, proxies, fingerprints — each had
 * their own copy of `used by N tasks: a, b, c and 14 more`, which was the worst of both
 * readings: too little to answer WHICH tasks, and long enough that the row truncated it
 * anyway, so what you saw was an arbitrary prefix of an arbitrary subset.
 *
 * A count is what a list row can usefully carry. The full list belongs in a popover, where
 * it can be complete and scroll.
 */
export function UsedByTasks({ tasks }: { tasks?: TaskRef[] }) {
  const { t } = useLang();
  // Same one-line interpolation the pages define locally; kept here so this component does
  // not depend on which of them happens to import it.
  const fill = (template: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);
  if (!tasks?.length) {
    return <span className="text-[11px] text-muted-foreground">{t.notInUse}</span>;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-[11px] text-muted-foreground inline-flex items-center gap-1 hover:text-foreground hover:underline underline-offset-2"
        >
          <Link2 className="h-3 w-3 shrink-0" />
          {fill(t.inUseByTasks, { n: tasks.length })}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="px-3 py-2 border-b border-border text-xs font-medium">
          {fill(t.inUseByTasks, { n: tasks.length })}
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {tasks.map((x) => (
            <div key={x.id} className="px-3 py-1 text-xs truncate" title={x.name}>
              {x.name}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
