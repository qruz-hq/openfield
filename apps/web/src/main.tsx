import "@openfield/ui/styles.css";
import { TooltipProvider } from "@openfield/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { queryClient } from "./api/client";
import { router } from "./router";
import { markWindowPlatform } from "./shell/window-chrome";

markWindowPlatform(document.documentElement);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
