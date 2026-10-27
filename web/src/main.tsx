import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={250}>
          {/* Motion's default ignores the OS setting; "user" turns off transform and layout animation for it.
              One critically damped spring for every animation that sets no transition of its own. */}
          <MotionConfig reducedMotion="user" transition={{ type: "spring", visualDuration: 0.25, bounce: 0 }}>
            <App />
          </MotionConfig>
          <Toaster position="bottom-right" closeButton />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
