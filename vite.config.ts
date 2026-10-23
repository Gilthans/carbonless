import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
				target: "http://127.0.0.1:4747",
				changeOrigin: true,
				headers: { origin: "http://127.0.0.1:4747" },
			},
		},
	},
});
