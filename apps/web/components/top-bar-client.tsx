'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from './top-bar';

export function TopBarClient() {
  const pathname = usePathname();
  return <TopBar activePath={pathname?.startsWith('/router') ? '/router' : '/'} />;
}
