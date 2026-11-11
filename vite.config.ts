import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { thirdPartyNotices } from "./scripts/third-party-notices.mjs";

// `pnpm dev`'s crb serve; CRB_API_PORT lets two worktrees run dev at once
// (Vite itself moves to the next free port when 5173 is taken). Never 4747:
// that's the owner's always-on server.
const api = `http://127.0.0.1:${process.env.CRB_API_PORT ?? "4858"}`;
// The API only accepts its own loopback Host and Origin (DNS rebinding
// guard), so the dev proxy presents itself as the API.
const toApi = { target: api, changeOrigin: true, headers: { origin: api } };

export default defineConfig({
	root: "src/web",
	// thirdPartyNotices: dist/THIRD-PARTY-NOTICES.md, from what the build uses.
	plugins: [react(), tailwindcss(), thirdPartyNotices()],
	build: {
		outDir: "../../dist/web",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": toApi,
			// A PR's address redirects to its review (/r/<id>, the page's own).
			"/pr": toApi,
		},
	},
});
