'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from './top-bar';

export function TopBarClient() {
  const pathname = usePathname();
  const activePath = pathname?.startsWith('/router')
    ? '/router'
    : pathname?.startsWith('/validation')
      ? '/validation'
      : '/';
  return <TopBar activePath={activePath} />;
}
