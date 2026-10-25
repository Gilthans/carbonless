import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev`'s API; CRB_API_PORT lets two worktrees run dev at once (Vite
// itself moves to the next free port when 5173 is taken).
const api = `http://127.0.0.1:${process.env.CRB_API_PORT ?? "4747"}`;

export default defineConfig({
	root: "src/web",
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "../../dist/web",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
		proxy: {
			// The API only accepts its own loopback Host and Origin (DNS
			// rebinding guard), so the dev proxy presents itself as the API.
			"/api": {
				target: api,
				changeOrigin: true,
				headers: { origin: api },
			},
		},
	},
});
