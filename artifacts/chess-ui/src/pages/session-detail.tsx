import React, { useEffect, useRef } from "react";
import { useGetSession, useGetSessionState, useGetSessionMoves, useGetSessionTiming, useStopSession, getGetSessionQueryKey, getGetSessionStateQueryKey, getGetSessionMovesQueryKey, getGetSessionTimingQueryKey } from "@workspace/api-client-react";
import { ChessBoard } from "@/components/board";
import { StatusBadge } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal, SquareSquare, Cpu, StopCircle, Clock, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

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
        {/* Left Column: Board & Stats */}
        <div className="w-full lg:w-[450px] shrink-0 flex flex-col gap-6 overflow-y-auto pr-2 pb-6">
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
