import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home, Search, Library, Download, Music2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/library', icon: Library, label: 'Library' },
  { to: '/import', icon: Download, label: 'Import' },
]

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 bottom-0 z-30 hidden w-64 flex-col border-r border-[var(--border)] bg-[var(--background-elevated)] md:flex">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-6">
        <div 
          className="flex h-10 w-10 items-center justify-center rounded-xl"
          style={{
            background: 'linear-gradient(135deg, var(--accent) 0%, #A78BFA 100%)',
            boxShadow: '0 4px 16px var(--accent-glow)',
          }}
        >
          <Music2 className="h-5 w-5 text-white" />
        </div>
        <span className="text-xl font-bold text-[var(--foreground)]">Sonora</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4">
        <ul className="space-y-1">
          {navItems.map(({ to, icon: Icon, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    'relative flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors',
                    isActive 
                      ? 'text-[var(--foreground)]' 
                      : 'text-[var(--foreground-muted)] hover:text-[var(--foreground-secondary)]'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <motion.div
                        className="absolute inset-0 rounded-xl bg-[var(--background-floating)]"
                        layoutId="sidebar-indicator"
                        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                      />
                    )}
                    <Icon className="relative h-5 w-5" />
                    <span className="relative">{label}</span>
                    {isActive && (
                      <div 
                        className="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full"
                        style={{ backgroundColor: 'var(--accent)' }}
                      />
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Footer */}
      <div className="border-t border-[var(--border)] px-6 py-4">
        <p className="text-xs text-[var(--foreground-muted)]">
          Self-hosted music streaming
        </p>
      </div>
    </aside>
  )
}
