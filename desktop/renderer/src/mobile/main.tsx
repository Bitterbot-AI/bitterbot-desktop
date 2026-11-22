import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/globals.css";
import "./mobile.css";
import { MobileApp } from "./MobileApp";
import { applyTheme } from "./theme";

// Theme before first paint, so a light-mode phone never flashes dark.
applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
