import Link from 'next/link';

export interface NavLink {
  href: string;
  label: string;
}

export function Nav({ links = [] }: { links?: NavLink[] }) {
  if (links.length === 0) {
    return null;
  }

  return (
    <nav className="flex items-center gap-4 border-b border-border px-6 py-4">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-sm font-medium text-foreground hover:opacity-70"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
