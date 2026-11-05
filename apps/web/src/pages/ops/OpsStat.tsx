import type { Icon } from '@phosphor-icons/react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** Round 30: the number cards at the top of an Ops page; `bad` turns a card red when it needs attention. */
export function Stat({ icon: I, label, value, sub, bad }: { icon: Icon; label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <Card className={cn('gap-1.5 px-4 py-3.5', bad && 'border-destructive/50')}>
      <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><I className="size-4" aria-hidden /> {label}</div>
      <div className={cn('text-2xl font-bold tabular-nums', bad && 'text-disputed-ink')}>{value}</div>
      <div className="text-xs text-muted-foreground tabular-nums">{sub}</div>
    </Card>
  );
}

export const initials = (name: string) => name.split(/[\s_]+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
