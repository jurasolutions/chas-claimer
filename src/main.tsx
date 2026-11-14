import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./design-system/styles.css";
import "./ui/app.css";
import { registerIcons } from "./lib/icons";
import { App } from "./ui/App";

registerIcons();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
