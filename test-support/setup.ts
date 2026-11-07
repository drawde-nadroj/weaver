/* Installs the DOM shim before any test module imports CodeMirror. */
import { vi } from "vitest";
import { installDom } from "./dom";

installDom();

// Shell tests exercise controller transitions, not a simulated Markdown renderer.
// The real persistent editor and native rendering are exercised in the live host.
vi.mock("../src/ui/markdown-pane", () => import("./markdown-pane-stub"));
