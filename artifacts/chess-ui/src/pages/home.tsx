import React, { useEffect } from "react";
import { Link } from "wouter";
import { useListSessions, useCreateSession, getListSessionsQueryKey, } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "@/components/layout";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Activity, Plus, Loader2, Zap, KeyRound, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ServerConfig {
  chessfriends: {
    username: string | null;
    hasPassword: boolean;
    password: string | null;
  };
  stockfish: {
    depth: number;
    movetime: number;
    moveDelayMs: number;
    moveJitterMs: number;
  };
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const sessionSchema = z.object({
  url: z.string().url(),
  color: z.enum(['w', 'b']),
  username: z.string().optional(),
  password: z.string().optional(),
  depth: z.coerce.number().default(18),
  movetime: z.coerce.number().default(3000),
  moveDelayMs: z.coerce.number().default(300),
  moveJitterMs: z.coerce.number().default(400),
  headless: z.boolean().default(true),
});

// ─── Home page ────────────────────────────────────────────────────────────────

export function Home() {
  const { data: sessions, isLoading } = useListSessions({ query: {
    queryKey: getListSessionsQueryKey(),
    refetchInterval: (query) => {
      const hasActive = query.state.data?.some(s => s.status === 'active' || s.status === 'starting');
      return hasActive ? 1500 : false;
    }
  } });

  return (
    <div className="p-6 h-full flex flex-col md:flex-row gap-6 max-w-7xl mx-auto w-full">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold tracking-tight">Active Sessions</h1>
        </div>
        <Card className="flex-1 overflow-hidden flex flex-col border-border bg-card/50 backdrop-blur">
          <div className="overflow-auto flex-1 p-0">
            {isLoading ? (
              <div className="p-8 flex items-center justify-center text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : sessions?.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
                <Activity className="w-12 h-12 mb-4 opacity-20" />
                <p className="font-mono text-sm uppercase tracking-wider">No active sessions</p>
                <p className="text-xs mt-2 opacity-60">Create a new session to begin automation</p>
              </div>
            ) : (
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground uppercase bg-muted/50 sticky top-0 backdrop-blur z-10">
                  <tr>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Target</th>
                    <th className="px-4 py-3 font-medium">Color</th>
                    <th className="px-4 py-3 font-medium text-right">Moves</th>
                    <th className="px-4 py-3 font-medium text-right">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sessions?.map(session => (
                    <tr key={session.id} className="hover:bg-muted/30 transition-colors group">
                      <td className="px-4 py-3">
                        <Link href={`/sessions/${session.id}`} className="block">
                          <div className="flex flex-col gap-1">
                            <StatusBadge status={session.status} />
                            {session.phase && session.status !== 'active' && session.status !== 'stopped' && (
                              <span className="text-[10px] font-mono text-muted-foreground">{session.phase}</span>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/sessions/${session.id}`} className="block text-primary hover:underline truncate max-w-[200px]">
                          {session.url}
                        </Link>
                        {session.errorMessage && (
                          <span className="block text-[10px] text-destructive mt-1 truncate max-w-[200px]" title={session.errorMessage}>
                            {session.errorMessage}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs px-2 py-1 rounded bg-muted">
                          {session.color === 'w' ? 'WHITE' : 'BLACK'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{session.moveCount}</td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {new Date(session.startedAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>

      <div className="w-full md:w-80 shrink-0">
        <Card className="border-border">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" />
              New Session
            </CardTitle>
          </CardHeader>
          <CardContent>
            <NewSessionForm />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── New session form ─────────────────────────────────────────────────────────

function NewSessionForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSession = useCreateSession();

  // Fetch server-side config (saved credentials + strength defaults)
  const { data: config } = useQuery<ServerConfig>({
    queryKey: ["server-config"],
    queryFn: async () => {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error("Failed to fetch config");
      return res.json();
    },
    staleTime: 60_000,
  });

  const hasSavedCreds = !!(config?.chessfriends.username && config?.chessfriends.hasPassword);

  const form = useForm<z.infer<typeof sessionSchema>>({
    resolver: zodResolver(sessionSchema),
    defaultValues: {
      url: "",
      color: "w",
      username: "",
      password: "",
      depth: 18,
      movetime: 3000,
      moveDelayMs: 300,
      moveJitterMs: 400,
      headless: true,
    }
  });

  // Auto-fill credentials from server config once loaded
  useEffect(() => {
    if (config?.chessfriends.username) {
      form.setValue("username", config.chessfriends.username);
    }
    if (config?.chessfriends.password) {
      form.setValue("password", config.chessfriends.password);
    }
  }, [config]);

  function applyChessfriendsPreset() {
    form.setValue("url", "https://www.chessfriends.com");
    form.setValue("color", "w");
    // Max strength from server config or hardcoded max defaults
    form.setValue("depth", config?.stockfish.depth ?? 30);
    form.setValue("movetime", config?.stockfish.movetime ?? 10000);
    form.setValue("moveDelayMs", config?.stockfish.moveDelayMs ?? 350);
    form.setValue("moveJitterMs", config?.stockfish.moveJitterMs ?? 600);
    form.setValue("headless", true);
    // Auto-fill saved credentials
    if (config?.chessfriends.username) form.setValue("username", config.chessfriends.username);
    if (config?.chessfriends.password) form.setValue("password", config.chessfriends.password);
  }

  function onSubmit(data: z.infer<typeof sessionSchema>) {
    // If credentials are empty in form but saved server-side, use server values
    const username = data.username || config?.chessfriends.username || undefined;
    const password = data.password || config?.chessfriends.password || undefined;

    createSession.mutate({
      data: { ...data, username, password }
    }, {
      onSuccess: () => {
        toast({ title: "Session created — Stockfish is connecting to ChessFriends" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        form.reset();
        // Re-apply saved credentials after reset
        if (config?.chessfriends.username) form.setValue("username", config.chessfriends.username);
        if (config?.chessfriends.password) form.setValue("password", config.chessfriends.password);
      },
      onError: (err) => {
        const msg = (err as { error?: string }).error ?? "Unknown error";
        toast({ title: "Error", description: msg, variant: "destructive" });
      }
    });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

        {/* Preset */}
        <div className="pb-1">
          <p className="text-xs text-muted-foreground uppercase mb-2">Quick Preset</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full font-mono text-xs border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
            onClick={applyChessfriendsPreset}
          >
            <Zap className="w-3 h-3 mr-1.5" />
            ChessFriends — Max Strength
          </Button>
        </div>

        {/* Saved credentials badge */}
        {hasSavedCreds && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-mono">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
            Credentials saved for <span className="font-bold">{config?.chessfriends.username}</span>
          </div>
        )}

        <FormField control={form.control} name="url" render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs uppercase text-muted-foreground">Target URL</FormLabel>
            <FormControl>
              <Input placeholder="https://..." className="font-mono text-xs" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="color" render={({ field }) => (
          <FormItem>
            <FormLabel className="text-xs uppercase text-muted-foreground">Play As</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue placeholder="Select color" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="w">White</SelectItem>
                <SelectItem value="b">Black</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="depth" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground">Depth</FormLabel>
              <FormControl>
                <Input type="number" className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="movetime" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground">Time (ms)</FormLabel>
              <FormControl>
                <Input type="number" className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="moveDelayMs" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground">Delay (ms)</FormLabel>
              <FormControl>
                <Input type="number" className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="moveJitterMs" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground">Jitter (ms)</FormLabel>
              <FormControl>
                <Input type="number" className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
        </div>

        <div className="pt-2 border-t border-border space-y-4">
          <FormField control={form.control} name="username" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="w-3 h-3" /> Username
                {hasSavedCreds && <span className="text-emerald-400 text-[10px]">auto-filled</span>}
              </FormLabel>
              <FormControl>
                <Input className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs uppercase text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="w-3 h-3" /> Password
                {hasSavedCreds && <span className="text-emerald-400 text-[10px]">auto-filled</span>}
              </FormLabel>
              <FormControl>
                <Input type="password" className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="headless" render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <FormLabel className="text-xs uppercase text-muted-foreground">Headless Mode</FormLabel>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )} />
        </div>

        <Button
          type="submit"
          className="w-full font-mono font-bold"
          disabled={createSession.isPending}
        >
          {createSession.isPending
            ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />CONNECTING…</>
            : "INITIATE SESSION"
          }
        </Button>
      </form>
    </Form>
  );
}
