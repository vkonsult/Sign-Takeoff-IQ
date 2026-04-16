import { useEffect, useRef, useState } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { QueryClient, QueryClientProvider, useQueryClient, useQuery } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useUser } from "@clerk/react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isGuestMode, apiFetch, setGuestToken } from "@/lib/apiClient";
import { useUserRole } from "@/hooks/use-user-role";

import Home from "@/pages/Home";
import LandingPage from "@/pages/LandingPage";
import JobsList from "@/pages/JobsList";
import JobDetails from "@/pages/JobDetails";
import Training from "@/pages/Training";
import NotFound from "@/pages/not-found";
import AdminDashboard from "@/pages/AdminDashboard";
import AdminOrgs from "@/pages/AdminOrgs";
import AdminUsers from "@/pages/AdminUsers";
import AdminVocabulary from "@/pages/AdminVocabulary";
import OnboardingPage from "@/pages/OnboardingPage";
import SettingsCompany from "@/pages/SettingsCompany";
import SettingsUsers from "@/pages/SettingsUsers";
import ActivityPage from "@/pages/ActivityPage";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL as string | undefined;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const AUTO_GUEST_TOKEN = import.meta.env.VITE_GUEST_TOKEN as string | undefined;

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
  const [, setLocation] = useLocation();
  const [guestAvailable, setGuestAvailable] = useState(!!AUTO_GUEST_TOKEN);

  useEffect(() => {
    fetch(`${basePath}/api/healthz`)
      .then((r) => r.json())
      .then((d: { guestAvailable?: boolean }) => setGuestAvailable(!!d.guestAvailable))
      .catch(() => {});
  }, []);

  function handleGuest() {
    if (AUTO_GUEST_TOKEN) {
      setGuestToken(AUTO_GUEST_TOKEN);
      setLocation("/jobs");
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={`${basePath}/jobs`}
      />
      {guestAvailable && (
        <button
          onClick={handleGuest}
          className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
        >
          Continue as Guest →
        </button>
      )}
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


/** Tenant-ADMIN only: requires signed-in ADMIN (not SUPER_ADMIN) with completed onboarding. */
function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, isAdmin, isSuperAdmin } = useUserRole();
  const { isSignedIn } = useUser();
  const [location] = useLocation();

  const isTenantAdmin = isAdmin && !isSuperAdmin;

  const orgQuery = useQuery({
    queryKey: ["admin-org-onboarding-check"],
    queryFn: async () => {
      const res = await apiFetch("/api/admin/org");
      if (!res.ok) return null;
      return res.json() as Promise<{ organization: { onboardingComplete: boolean } }>;
    },
    enabled: !isGuestMode() && isLoaded && isTenantAdmin && !!isSignedIn,
    staleTime: 30_000,
  });

  if (isGuestMode()) {
    return <Component />;
  }
  if (!isSignedIn) {
    return <Redirect to="/sign-in" />;
  }
  if (!isLoaded) {
    return null;
  }
  if (!isTenantAdmin) {
    return <Redirect to="/jobs" />;
  }
  if (orgQuery.isLoading) {
    return null;
  }
  if (
    orgQuery.data !== undefined &&
    orgQuery.data !== null &&
    !orgQuery.data.organization.onboardingComplete &&
    location !== "/onboarding"
  ) {
    return <Redirect to="/onboarding" />;
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
  if (!isLoaded) {
    return null;
  }
  if (!isSuperAdmin) {
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

/** Guard for /onboarding: must be signed-in ADMIN; redirect away if already complete. */
function OnboardingRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, isAdmin, isSuperAdmin } = useUserRole();
  const { isSignedIn } = useUser();

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

  if (!isSignedIn) {
    return <Redirect to="/sign-in" />;
  }
  if (!isLoaded) {
    return null;
  }
  if (!isAdmin || isSuperAdmin) {
    return <Redirect to="/jobs" />;
  }
  if (orgQuery.isLoading) {
    return null;
  }
  if (orgQuery.data?.organization?.onboardingComplete) {
    return <Redirect to="/jobs" />;
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
      <Route path="/onboarding">
        {() => <OnboardingRoute component={OnboardingPage} />}
      </Route>
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
      <Route path="/activity">
        {() => <OnboardingGuard component={ActivityPage} />}
      </Route>
      <Route path="/settings">
        {() => <AdminRoute component={SettingsCompany} />}
      </Route>
      <Route path="/settings/users">
        {() => <AdminRoute component={SettingsUsers} />}
      </Route>
      <Route path="/admin">
        {() => <SuperAdminRoute component={AdminDashboard} />}
      </Route>
      <Route path="/admin/organizations">
        {() => <SuperAdminRoute component={AdminOrgs} />}
      </Route>
      <Route path="/admin/users">
        {() => <SuperAdminRoute component={AdminUsers} />}
      </Route>
      <Route path="/admin/vocabulary">
        {() => <SuperAdminRoute component={AdminVocabulary} />}
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
    <ErrorBoundary>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </ErrorBoundary>
  );
}

export default App;
