import { createRoot } from "react-dom/client";
import App from "./App";
import { observeApiAuthFailures } from "./lib/queryClient";
import "./i18n";
import "./index.css";

window.fetch = observeApiAuthFailures(window.fetch.bind(window));

createRoot(document.getElementById("root")!).render(<App />);
