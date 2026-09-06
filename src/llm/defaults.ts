export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const OLLAMA_MODEL_PREFERENCE = ["qwen3", "llama3.3", "llama3.1", "mistral"];
export const ENDPOINT_TIMEOUT_MS = 60_000;
export const SPAWN_TIMEOUT_MS = 300_000;
export const SPAWN_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;
export const SPAWN_KILL_GRACE_MS = 10_000;
