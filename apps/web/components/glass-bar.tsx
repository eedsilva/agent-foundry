import React, { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function GlassBar({
  as: Tag = 'div',
  className,
  children,
}: {
  as?: 'header' | 'div' | 'nav' | 'section';
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cn('glass rounded-panel', className)}>{children}</Tag>;
}
