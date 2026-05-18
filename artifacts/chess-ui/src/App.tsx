import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { Home } from "@/pages/home";
import { SessionDetail } from "@/pages/session-detail";
import { Analyze } from "@/pages/analyze";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Layout><Home /></Layout>
      </Route>
      <Route path="/sessions/:id">
        {params => <Layout><SessionDetail id={params.id} /></Layout>}
      </Route>
      <Route path="/analyze">
        <Layout><Analyze /></Layout>
      </Route>
      <Route>
        <Layout><NotFound /></Layout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
