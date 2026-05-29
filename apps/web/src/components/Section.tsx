import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SectionProps {
  title: string
  subtitle?: string
  children: ReactNode
  className?: string
  action?: ReactNode
}

export function Section({ title, subtitle, children, className, action }: SectionProps) {
  return (
    <section className={cn('mb-8', className)}>
      <div className="mb-4 flex items-end justify-between px-4">
        <div>
          <h2 className="text-xl font-semibold text-[var(--foreground)]">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-sm text-[var(--foreground-muted)]">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
