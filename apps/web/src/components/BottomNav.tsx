import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home, Search, Library, Download } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/search', icon: Search, label: 'Search' },
  { to: '/library', icon: Library, label: 'Library' },
  { to: '/import', icon: Download, label: 'Import' },
]

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-xl md:hidden">
      <div className="flex items-center justify-around px-4 py-2 pb-safe">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'relative flex flex-col items-center gap-1 px-4 py-2 transition-colors',
                isActive ? 'text-[var(--foreground)]' : 'text-[var(--foreground-muted)]'
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.div
                    className="absolute inset-0 rounded-xl bg-[var(--accent)]/10"
                    layoutId="nav-indicator"
                    transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                  />
                )}
                <Icon className="relative h-5 w-5" />
                <span className="relative text-[10px] font-medium">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
