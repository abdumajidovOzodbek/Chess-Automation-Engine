import React, { useEffect, useRef, useState } from "react";
import { useGetSession, useGetSessionState, useGetSessionMoves, useGetSessionTiming, useStopSession, getGetSessionQueryKey, getGetSessionStateQueryKey, getGetSessionMovesQueryKey, getGetSessionTimingQueryKey } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { ChessBoard } from "@/components/board";
import { StatusBadge } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal, SquareSquare, Cpu, StopCircle, Clock, Loader2, Radio, ChevronDown, ChevronRight, Wifi, WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

// ─── WS Diagnostics types ─────────────────────────────────────────────────────

interface WSFrame {
  frameIndex: number;
  dir: "send" | "recv";
  ts: number;
  hasGameEvent: boolean;
  gameEventType: string | null;
  parsed: unknown;
  innerParams: unknown;
  gameEvent?: unknown;
}

interface WSDiagnostics {
  sessionId: string;
  enabled: boolean;
  active?: boolean;
  wsUrl?: string | null;
  totalFrames?: number;
  gameFrames?: number;
  currentFen?: string;
  recentFrames?: WSFrame[];
  allGameFrames?: WSFrame[];
  message?: string;
}

// ─── WS Diagnostics panel ────────────────────────────────────────────────────

function WsDiagnosticsPanel({ id, isActive }: { id: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTab, setSelectedTab] = useState<"game" | "recent">("game");

  const { data: diag, isLoading } = useQuery<WSDiagnostics>({
    queryKey: ["ws-diagnostics", id],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${id}/ws-diagnostics`);
      if (!res.ok) throw new Error("Failed to fetch WS diagnostics");
      return res.json();
    },
    enabled: !!id && expanded,
    refetchInterval: isActive && expanded ? 2000 : false,
  });

  return (
    <Card className="border-border bg-card/50 backdrop-blur shrink-0">
      <button
        className="w-full text-left px-4 py-3 flex items-center gap-2 hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <Radio className="w-4 h-4 text-primary" />
        <span className="text-sm font-mono font-bold uppercase tracking-wider flex-1">
          WS Protocol Capture
        </span>
        {diag?.enabled && diag.totalFrames != null && (
          <span className="text-xs font-mono text-muted-foreground mr-2">
            {diag.totalFrames} frames · {diag.gameFrames ?? 0} game events
          </span>
        )}
        {diag?.active != null && (
          diag.active
            ? <Wifi className="w-3 h-3 text-emerald-400 mr-1" />
            : <WifiOff className="w-3 h-3 text-muted-foreground mr-1" />
        )}
        {expanded
          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
          : <ChevronRight className="w-4 h-4 text-muted-foreground" />
        }
      </button>

      {expanded && (
        <div className="border-t border-border">
          {isLoading && (
            <div className="p-6 flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {diag && !diag.enabled && (
            <div className="p-4 text-sm font-mono text-muted-foreground">
              {diag.message ?? "WS capture not enabled for this session."}
            </div>
          )}

          {diag?.enabled && (
            <div className="p-4 space-y-4">
              {/* Status bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatPill label="WS URL" value={diag.wsUrl ? new URL(diag.wsUrl).host : "—"} />
                <StatPill label="Total Frames" value={String(diag.totalFrames ?? 0)} />
                <StatPill label="Game Events" value={String(diag.gameFrames ?? 0)} highlight />
                <StatPill label="Current FEN" value={diag.currentFen ? diag.currentFen.slice(0, 20) + "…" : "—"} mono />
              </div>

              {/* Tab bar */}
              <div className="flex gap-2 border-b border-border pb-2">
                {(["game", "recent"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setSelectedTab(tab)}
                    className={`text-xs font-mono uppercase px-3 py-1 rounded transition-colors ${
                      selectedTab === tab
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {tab === "game" ? `Game Events (${diag.allGameFrames?.length ?? 0})` : `Recent Frames (last ${diag.recentFrames?.length ?? 0})`}
                  </button>
                ))}
              </div>

              {/* Frame list */}
              <div className="max-h-[400px] overflow-y-auto space-y-2 pr-1">
                {selectedTab === "game" && (diag.allGameFrames?.length ?? 0) === 0 && (
                  <div className="text-xs font-mono text-muted-foreground text-center py-6">
                    No game events detected yet. Game-state frames arrive after frame 60+ on ChessFriends.
                  </div>
                )}
                {(selectedTab === "game" ? diag.allGameFrames : diag.recentFrames)?.map((frame) => (
                  <FrameRow key={`${frame.frameIndex}-${frame.ts}`} frame={frame} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatPill({ label, value, highlight, mono }: { label: string; value: string; highlight?: boolean; mono?: boolean }) {
  return (
    <div className="bg-muted/40 rounded px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div className={`text-sm font-mono truncate ${highlight ? "text-emerald-400 font-bold" : mono ? "text-[11px]" : "text-foreground"}`}>
        {value}
      </div>
    </div>
  );
}

function FrameRow({ frame }: { frame: WSFrame }) {
  const [open, setOpen] = useState(false);
  const ts = new Date(frame.ts).toISOString().slice(11, 23);

  return (
    <div className={`rounded border text-xs font-mono ${frame.hasGameEvent ? "border-emerald-500/40 bg-emerald-950/20" : "border-border/50 bg-muted/10"}`}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${
          frame.dir === "send" ? "bg-blue-500/20 text-blue-400" : "bg-amber-500/20 text-amber-400"
        }`}>
          {frame.dir === "send" ? "↑ send" : "↓ recv"}
        </span>
        <span className="text-muted-foreground shrink-0">[{frame.frameIndex}]</span>
        <span className="text-muted-foreground shrink-0">{ts}</span>
        {frame.hasGameEvent && (
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[10px] uppercase font-bold">
            {frame.gameEventType}
          </span>
        )}
        <span className="text-muted-foreground truncate flex-1 text-right opacity-60">
          {JSON.stringify(frame.parsed).slice(0, 80)}
        </span>
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border/50 px-3 py-2 space-y-2">
          {frame.innerParams !== undefined && (
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Decoded params (inner)</div>
              <pre className="text-[11px] text-foreground/80 whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-48 overflow-y-auto">
                {JSON.stringify(frame.innerParams, null, 2)}
              </pre>
            </div>
          )}
          {frame.gameEvent != null && (
            <div>
              <div className="text-[10px] uppercase text-emerald-400/80 mb-1">Game event extracted</div>
              <pre className="text-[11px] text-emerald-300/80 whitespace-pre-wrap break-all bg-emerald-950/30 rounded p-2 max-h-48 overflow-y-auto">
                {JSON.stringify(frame.gameEvent, null, 2)}
              </pre>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1">Raw parsed frame</div>
            <pre className="text-[11px] text-foreground/60 whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-48 overflow-y-auto">
              {JSON.stringify(frame.parsed, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function SessionDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { data: session } = useGetSession(id, { query: { enabled: !!id, queryKey: getGetSessionQueryKey(id) } });
  
  const isActive = session?.status === 'active' || session?.status === 'starting';

  const { data: state } = useGetSessionState(id, { query: { 
    enabled: !!id,
    queryKey: getGetSessionStateQueryKey(id),
    refetchInterval: isActive ? 1500 : false 
  } });

  const { data: moves } = useGetSessionMoves(id, { query: { 
    enabled: !!id,
    queryKey: getGetSessionMovesQueryKey(id),
    refetchInterval: isActive ? 2000 : false 
  } });

  const { data: timing } = useGetSessionTiming(id, { query: { 
    enabled: !!id,
    queryKey: getGetSessionTimingQueryKey(id),
    refetchInterval: isActive ? 5000 : false 
  } });

  const stopSession = useStopSession();

  const handleStop = () => {
    stopSession.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(id) });
      }
    });
  };

  const movesEndRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (movesEndRef.current) {
      movesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [moves]);

  if (!session) return <div className="p-8 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="p-6 h-full flex flex-col max-w-[1600px] mx-auto w-full gap-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono flex items-center gap-3">
            SESSION // {id.substring(0,8)}
            <StatusBadge status={session.status} />
          </h1>
          <p className="text-muted-foreground text-sm font-mono mt-1">{session.url}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={async () => {
            if (!session) return;
            try {
              const res = await fetch(`/api/sessions/${id}/pgn`);
              const data = await res.json();
              if (data.pgn) {
                const blob = new Blob([data.pgn], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `session-${id}.pgn`;
                link.click();
                URL.revokeObjectURL(url);
              }
            } catch (err) {
              console.error("Failed to export PGN", err);
            }
          }} className="font-mono font-bold">
            EXPORT PGN
          </Button>
          {isActive && (
            <Button variant="destructive" onClick={handleStop} disabled={stopSession.isPending} className="font-mono font-bold">
              <StopCircle className="w-4 h-4 mr-2" />
              TERMINATE
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
        {/* Left Column: Board & Stats & WS Diagnostics */}
        <div className="w-full lg:w-[480px] shrink-0 flex flex-col gap-6 overflow-y-auto pr-2 pb-6">
          <Card className="border-border bg-card/50 backdrop-blur">
            <CardContent className="p-6 flex justify-center">
              <ChessBoard 
                fen={state?.fen || session.currentFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"} 
                color={session.color}
                lastMove={state?.lastMove || session.lastMove}
              />
            </CardContent>
            <div className="px-6 pb-6 pt-0 font-mono text-xs text-muted-foreground text-center break-all">
              {state?.fen || session.currentFen}
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <Card className="border-border">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground uppercase mb-1 flex items-center gap-2"><Cpu className="w-3 h-3"/> Engine Config</div>
                <div className="font-mono text-sm">Depth: {session.config.depth}</div>
                <div className="font-mono text-sm">Time: {session.config.movetime}ms</div>
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground uppercase mb-1 flex items-center gap-2"><Clock className="w-3 h-3"/> Timing</div>
                <div className="font-mono text-sm">Avg Think: {timing?.averageThinkingMs ? `${Math.round(timing.averageThinkingMs)}ms` : '--'}</div>
                <div className="font-mono text-sm">Avg Exec: {timing?.averageExecutionMs ? `${Math.round(timing.averageExecutionMs)}ms` : '--'}</div>
              </CardContent>
            </Card>
          </div>

          {/* WS Protocol Capture panel */}
          <WsDiagnosticsPanel id={id} isActive={isActive} />
        </div>

        {/* Right Column: Move History */}
        <Card className="flex-1 flex flex-col border-border bg-card/50 backdrop-blur min-h-0">
          <CardHeader className="py-4 border-b border-border bg-muted/20 shrink-0">
            <CardTitle className="text-sm uppercase tracking-wider flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              Execution Log
            </CardTitle>
          </CardHeader>
          <div className="flex-1 overflow-auto p-0 bg-[#0a0f1c]">
            <table className="w-full text-sm text-left font-mono">
              <thead className="text-xs text-muted-foreground bg-muted/80 sticky top-0 z-10 backdrop-blur">
                <tr>
                  <th className="px-4 py-2 font-medium w-16">#</th>
                  <th className="px-4 py-2 font-medium">Move</th>
                  <th className="px-4 py-2 font-medium">Eval</th>
                  <th className="px-4 py-2 font-medium text-right">Think (ms)</th>
                  <th className="px-4 py-2 font-medium text-right">Exec (ms)</th>
                  <th className="px-4 py-2 font-medium text-center">Src</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {moves?.map((move) => (
                  <tr key={move.id} className="hover:bg-primary/5 transition-colors">
                    <td className="px-4 py-2 text-muted-foreground">{move.moveNumber}{move.color === 'w' ? '.' : '...'}</td>
                    <td className="px-4 py-2 font-bold text-foreground">{move.san}</td>
                    <td className="px-4 py-2 text-xs">
                      {move.engineScore != null ? (
                        <span className={move.engineScore > 0 ? "text-emerald-400" : move.engineScore < 0 ? "text-destructive" : "text-muted-foreground"}>
                          {move.engineScore > 0 ? '+' : ''}{move.engineScore.toFixed(2)}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{move.thinkingTimeMs}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{move.executionTimeMs}</td>
                    <td className="px-4 py-2 text-center">
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground">
                        {move.source}
                      </span>
                    </td>
                  </tr>
                ))}
                <tr ref={movesEndRef} />
              </tbody>
            </table>
            {!moves?.length && (
              <div className="p-8 text-center text-muted-foreground text-sm font-mono flex flex-col items-center">
                <SquareSquare className="w-8 h-8 mb-4 opacity-20" />
                Awaiting moves...
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
