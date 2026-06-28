"use client";

import { useState } from "react";

function randomHex() {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0").slice(0, 6);
}

export default function AddUserForm() {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [result, setResult] = useState<{ checkinTopic: string; nudgeTopic: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    const slug = id.toLowerCase().trim().replace(/\s+/g, "-");
    const checkinTopic = `${slug}-checkins-${randomHex()}`;
    const nudgeTopic = `${slug}-nudge-${randomHex()}`;

    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: slug, label: label.trim(), checkinTopic, nudgeTopic }),
    });

    setLoading(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to add user");
      return;
    }

    setResult({ checkinTopic, nudgeTopic });
    setId("");
    setLabel("");
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Add user</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex gap-3">
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="user-id (e.g. alice)"
            required
            className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-gray-400"
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Display name (e.g. Alice)"
            required
            className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-gray-400"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="bg-gray-900 text-white rounded-xl px-5 py-2.5 text-sm font-semibold hover:bg-gray-700 disabled:opacity-50 transition-colors self-start"
        >
          {loading ? "Adding…" : "Add user"}
        </button>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </form>

      {result && (
        <div className="mt-5 p-4 bg-gray-50 rounded-xl space-y-2">
          <p className="text-sm font-semibold text-gray-700">User added — share these ntfy links:</p>
          <TopicRow label="Habit completions" topic={result.checkinTopic} />
          <TopicRow label="Nudge reminders" topic={result.nudgeTopic} />
          <p className="text-xs text-gray-400 pt-1">Reload the page to see them in the list above.</p>
        </div>
      )}
    </div>
  );
}

function TopicRow({ label, topic }: { label: string; topic: string }) {
  const url = `https://ntfy.sh/${topic}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-gray-500 w-36 flex-shrink-0">{label}</span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline font-mono text-xs break-all">
        {url}
      </a>
    </div>
  );
}
