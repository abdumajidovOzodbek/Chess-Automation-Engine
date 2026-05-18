import React from "react";
import { Link } from "wouter";
import { useListSessions, useCreateSession, getListSessionsQueryKey, SessionSummaryStatus } from "@workspace/api-client-react";
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
import { Activity, Plus, Loader2, Zap } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

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
                          <StatusBadge status={session.status} />
                        </Link>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/sessions/${session.id}`} className="block text-primary hover:underline truncate max-w-[200px]">
                          {session.url}
                        </Link>
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

const CHESSFRIENDS_PRESET = {
  url: "https://www.chessfriends.com",
  color: "w" as const,
  depth: 18,
  movetime: 3000,
  moveDelayMs: 350,
  moveJitterMs: 500,
  headless: true,
};

function NewSessionForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createSession = useCreateSession();

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

  function onSubmit(data: z.infer<typeof sessionSchema>) {
    createSession.mutate({ data }, {
      onSuccess: () => {
        toast({ title: "Session created" });
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        form.reset();
      },
      onError: (err) => {
        const msg = (err as { error?: string }).error ?? "Unknown error";
        toast({ title: "Error", description: msg, variant: "destructive" });
      }
    });
  }

  function applyPreset(preset: typeof CHESSFRIENDS_PRESET) {
    form.setValue("url", preset.url);
    form.setValue("color", preset.color);
    form.setValue("depth", preset.depth);
    form.setValue("movetime", preset.movetime);
    form.setValue("moveDelayMs", preset.moveDelayMs);
    form.setValue("moveJitterMs", preset.moveJitterMs);
    form.setValue("headless", preset.headless);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">

        <div className="pb-1">
          <p className="text-xs text-muted-foreground uppercase mb-2">Quick Preset</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full font-mono text-xs border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
            onClick={() => applyPreset(CHESSFRIENDS_PRESET)}
          >
            <Zap className="w-3 h-3 mr-1.5" />
            ChessFriends.com
          </Button>
        </div>

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
            <Select onValueChange={field.onChange} defaultValue={field.value}>
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

        <div className="pt-2 border-t border-border">
          <FormField control={form.control} name="username" render={({ field }) => (
            <FormItem className="mb-4">
              <FormLabel className="text-xs uppercase text-muted-foreground">Username (opt)</FormLabel>
              <FormControl>
                <Input className="font-mono text-xs" {...field} />
              </FormControl>
            </FormItem>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <FormItem className="mb-4">
              <FormLabel className="text-xs uppercase text-muted-foreground">Password (opt)</FormLabel>
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

        <Button type="submit" className="w-full font-mono font-bold" disabled={createSession.isPending}>
          {createSession.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "INITIATE"}
        </Button>
      </form>
    </Form>
  );
}
