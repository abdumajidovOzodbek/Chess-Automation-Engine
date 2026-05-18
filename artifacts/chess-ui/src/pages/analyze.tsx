import React, { useState } from "react";
import { useAnalyzePosition, AnalysisRequest } from "@workspace/api-client-react";
import { ChessBoard } from "@/components/board";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Zap, Target } from "lucide-react";

export function Analyze() {
  const [fen, setFen] = useState("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const [depth, setDepth] = useState(20);
  const [multiPv, setMultiPv] = useState(3);
  
  const analyze = useAnalyzePosition();

  const handleAnalyze = () => {
    analyze.mutate({ data: { fen, depth, multiPv } });
  };

  const result = analyze.data;

  return (
    <div className="p-6 h-full flex flex-col max-w-[1400px] mx-auto w-full gap-6">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-2xl font-bold tracking-tight font-mono flex items-center gap-3">
          <Target className="w-6 h-6 text-primary" />
          STANDALONE ANALYSIS
        </h1>
      </div>

      <Card className="border-border shrink-0">
        <CardContent className="p-4 grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-8 space-y-1">
            <Label className="text-xs uppercase text-muted-foreground">FEN Position</Label>
            <Input 
              value={fen} 
              onChange={e => setFen(e.target.value)} 
              className="font-mono text-sm"
              placeholder="Paste FEN here..."
            />
          </div>
          <div className="md:col-span-2 space-y-1">
            <Label className="text-xs uppercase text-muted-foreground">Depth</Label>
            <Input 
              type="number" 
              value={depth} 
              onChange={e => setDepth(parseInt(e.target.value))} 
              className="font-mono text-sm"
            />
          </div>
          <div className="md:col-span-2 space-y-1">
            <Button 
              className="w-full font-mono font-bold" 
              onClick={handleAnalyze} 
              disabled={analyze.isPending || !fen}
            >
              {analyze.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "COMPUTE"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-0">
        <div className="w-full lg:w-[450px] shrink-0 flex flex-col gap-6">
          <Card className="border-border bg-card/50 backdrop-blur">
            <CardContent className="p-6 flex justify-center">
              <ChessBoard fen={fen} lastMove={result?.bestMove} />
            </CardContent>
          </Card>
        </div>

        <Card className="flex-1 flex flex-col border-border bg-card/50 backdrop-blur min-h-0">
          <CardHeader className="py-4 border-b border-border bg-muted/20 shrink-0">
            <CardTitle className="text-sm uppercase tracking-wider flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                Engine Evaluation
              </div>
              {result && (
                <div className="text-xs text-muted-foreground font-mono font-normal">
                  Time: {result.thinkingTimeMs}ms
                </div>
              )}
            </CardTitle>
          </CardHeader>
          <div className="flex-1 overflow-auto p-0 bg-[#0a0f1c]">
            {!result ? (
              <div className="p-12 text-center text-muted-foreground font-mono text-sm flex flex-col items-center">
                <Target className="w-8 h-8 mb-4 opacity-20" />
                Provide a FEN and compute to see analysis lines.
              </div>
            ) : (
              <table className="w-full text-sm text-left font-mono">
                <thead className="text-xs text-muted-foreground bg-muted/80 sticky top-0 z-10 backdrop-blur">
                  <tr>
                    <th className="px-4 py-2 font-medium w-12 text-center">Rank</th>
                    <th className="px-4 py-2 font-medium">Eval</th>
                    <th className="px-4 py-2 font-medium">Move</th>
                    <th className="px-4 py-2 font-medium">Line (PV)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {result.lines.map((line, i) => (
                    <tr key={i} className="hover:bg-primary/5 transition-colors">
                      <td className="px-4 py-3 text-center text-muted-foreground">#{line.rank}</td>
                      <td className="px-4 py-3 font-bold">
                        {line.mate ? (
                          <span className="text-emerald-400">M{line.mate}</span>
                        ) : (
                          <span className={(line.score || 0) > 0 ? "text-emerald-400" : (line.score || 0) < 0 ? "text-destructive" : "text-muted-foreground"}>
                            {(line.score || 0) > 0 ? '+' : ''}{((line.score || 0) / 100).toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-bold text-primary">{line.san || line.uci}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs leading-relaxed max-w-[400px] truncate">
                        {line.pv?.slice(0, 8).join(" ")}
                        {line.pv && line.pv.length > 8 ? " ..." : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
