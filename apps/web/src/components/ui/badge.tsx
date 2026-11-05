import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** Status badges: the money states use the Frost tokens (held / released / disputed). */
const badgeVariants = cva('inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold [&>svg]:size-3', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      outline: 'border-border text-muted-foreground',
      warning: 'border-transparent bg-held/15 text-held-ink',
      info: 'border-transparent bg-info/15 text-info-ink',
      success: 'border-transparent bg-released/15 text-released-ink',
      destructive: 'border-transparent bg-destructive/12 text-disputed-ink',
    },
  },
  defaultVariants: { variant: 'default' },
});

function Badge({ className, variant, dot, children, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
