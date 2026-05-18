import React from "react";
import { Link, useLocation } from "wouter";
import { Activity, Target, Network, CheckCircle, AlertCircle, Clock, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { SessionSummaryStatus } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Sessions", icon: Activity },
    { href: "/analyze", label: "Analysis", icon: Target },
  ];

  return (
    <div className="flex min-h-screen w-full flex-col md:flex-row">
      <aside className="w-full md:w-64 border-r border-border bg-sidebar flex flex-col">
        <div className="p-4 border-b border-sidebar-border">
          <div className="flex items-center gap-2 font-bold text-lg text-sidebar-foreground">
            <SquareTerminal className="w-5 h-5 text-primary" />
            <span>CHESS/RES</span>
          </div>
          <p className="text-xs text-sidebar-foreground/60 font-mono mt-1 tracking-wider uppercase">Automation Terminal</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-sidebar-border text-xs font-mono text-sidebar-foreground/40">
          SYSTEM_READY
        </div>
      </aside>
      <main className="flex-1 flex flex-col bg-background relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-[0.015] mix-blend-overlay bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPgo8cmVjdCB3aWR0aD0iNCIgaGVpZ2h0PSI0IiBmaWxsPSIjZmZmIiAvPgo8cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxIiBmaWxsPSIjMDAwIiAvPgo8L3N2Zz4=')]"></div>
        {children}
      </main>
    </div>
  );
}

export function StatusBadge({ status }: { status: SessionSummaryStatus }) {
  switch (status) {
    case 'active':
      return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> ACTIVE</span>;
    case 'starting':
      return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"><Clock className="w-3 h-3" /> STARTING</span>;
    case 'paused':
      return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20">PAUSED</span>;
    case 'stopped':
      return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground border border-muted-foreground/20"><CheckCircle className="w-3 h-3" /> STOPPED</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-destructive/10 text-destructive-foreground border border-destructive/20"><AlertCircle className="w-3 h-3" /> ERROR</span>;
    default:
      return null;
  }
}
