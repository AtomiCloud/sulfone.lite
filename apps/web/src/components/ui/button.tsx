import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

const tones: Record<ButtonTone, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

export function Button({
  className,
  tone = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return <button className={cn(tones[tone], className)} {...props} />;
}

export function ButtonLink({
  children,
  className,
  tone = 'primary',
  href,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  href: string;
  prefetch?: boolean;
  tone?: ButtonTone;
}) {
  return (
    <Link className={cn(tones[tone], className)} href={href} {...props}>
      {children}
    </Link>
  );
}
