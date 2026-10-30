import path from "node:path";
import { CONFIG_DIR } from "../utils.js";
import { BrowserTeachingStore } from "./teaching-store.js";

export const browserTeaching = new BrowserTeachingStore(path.join(CONFIG_DIR, "browser-teaching"));
