import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { makeGitHubFetcher } from "./engine/github.ts";

// Unauthenticated — the spike needs no token.
const fetchCommit = makeGitHubFetcher();
const REPO = { owner: "anthropics", repo: "skills", branch: "main" };

function App() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    // Each result goes to React state and, via invoke, the dev terminal.
    const poll = async (trigger: string) => {
      const r = await fetchCommit(REPO.owner, REPO.repo, REPO.branch);
      const ts = new Date().toISOString();
      const line = r.ok
        ? `${ts} [web:${trigger}] ok ${r.commit.sha.slice(0, 7)} @ ${r.commit.date}`
        : `${ts} [web:${trigger}] FAIL ${r.error}`;
      invoke("log", { line });
      setLines((prev) => [line, ...prev].slice(0, 50));
    };

    // Fetch on mount: covers the startup race where Rust's first emit beats
    // this listener (events aren't buffered).
    poll("mount");
    const unlisten = listen("poll-tick", () => poll("tick"));
    return () => void unlisten.then((f) => f());
  }, []);

  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>skill-drift spike — hidden background poll</h1>
      <pre>{lines.join("\n")}</pre>
    </main>
  );
}

export default App;
