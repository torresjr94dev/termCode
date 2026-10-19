import { defineConfig, mergeConfig, type UserConfig } from "vite";
import base from "../vite.config";

// La config de la app con un caché de dependencias propio: las e2e no tocan el
// del servidor de desarrollo, y en CI siempre arrancan en frío igual.
export default defineConfig((env) => mergeConfig(base(env) as UserConfig, { cacheDir: "node_modules/.vite-e2e" }));
