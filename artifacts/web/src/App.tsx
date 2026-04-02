import { useEffect, useRef } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from "@clerk/react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isGuestMode, apiFetch } from "@/lib/apiClient";
import { useUserRole } from "@/hooks/use-user-role";

import Home from "@/pages/Home";
import LandingPage from "@/pages/LandingPage";
import JobsList from "@/pages/JobsList";
import JobDetails from "@/pages/JobDetails";
import Training from "@/pages/Training";
import NotFound from "@/pages/not-found";
import AdminPanel from "@/pages/AdminPanel";
import OnboardingPage from "@/pages/OnboardingPage";
import SettingsCompany from "@/pages/SettingsCompany";
import SettingsUsers from "@/pages/SettingsUsers";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL as string | undefined;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY environment variable");
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if ((error as { status?: number })?.status === 404) return false;
        return failureCount < 3;
      },
    },
  },
});

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={`${basePath}/jobs`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={`${basePath}/jobs`}
      />
    </div>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  if (isGuestMode()) {
    return <Component />;
  }
  return (
    <>
      <Show when="signed-in">
        <Component />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, isAdmin } = useUserRole();
  const { isSignedIn } = useUser();

  if (isGuestMode()) {
    return <Component />;
  }
  if (!isSignedIn) {
    return <Redirect to="/sign-in" />;
  }
  if (isLoaded && !isAdmin) {
    return <Redirect to="/jobs" />;
  }
  return <Component />;
}

function SuperAdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, isSuperAdmin } = useUserRole();
  const { isSignedIn } = useUser();

  if (isGuestMode()) {
    return <Component />;
  }
  if (!isSignedIn) {
    return <Redirect to="/sign-in" />;
  }
  if (isLoaded && !isSuperAdmin) {
    return <Redirect to="/jobs" />;
  }
  return <Component />;
}

/** For ADMIN users, check onboarding_complete; if false, redirect to /onboarding. */
function OnboardingGuard({ component: Component }: { component: React.ComponentType }) {
  const { isAdmin, isSuperAdmin, isLoaded } = useUserRole();
  const { isSignedIn } = useUser();
  const [location] = useLocation();

  const orgQuery = useQuery({
    queryKey: ["admin-org-onboarding-check"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/org");
      if (!res.ok) return null;
      return res.json() as Promise<{ organization: { onboardingComplete: boolean } }>;
    },
    enabled: !isGuestMode() && isLoaded && isAdmin && !isSuperAdmin && !!isSignedIn,
    staleTime: 30_000,
  });

  if (isGuestMode()) {
    return <Component />;
  }
  if (!isSignedIn) {
    return <Redirect to="/sign-in" />;
  }
  if (!isLoaded || (isAdmin && !isSuperAdmin && orgQuery.isLoading)) {
    return null;
  }
  if (
    isAdmin &&
    !isSuperAdmin &&
    orgQuery.data !== undefined &&
    orgQuery.data !== null &&
    !orgQuery.data.organization.onboardingComplete &&
    location !== "/onboarding"
  ) {
    return <Redirect to="/onboarding" />;
  }
  return <Component />;
}

function HomeRoute() {
  if (isGuestMode()) {
    return <Redirect to="/jobs" />;
  }
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/jobs" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route path="/new-upload">
        {() => <OnboardingGuard component={Home} />}
      </Route>
      <Route path="/jobs">
        {() => <OnboardingGuard component={JobsList} />}
      </Route>
      <Route path="/jobs/:jobId">
        {() => <OnboardingGuard component={JobDetails} />}
      </Route>
      <Route path="/training">
        {() => <OnboardingGuard component={Training} />}
      </Route>
      <Route path="/settings">
        {() => <AdminRoute component={SettingsCompany} />}
      </Route>
      <Route path="/settings/users">
        {() => <AdminRoute component={SettingsUsers} />}
      </Route>
      <Route path="/admin">
        {() => <SuperAdminRoute component={AdminPanel} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
