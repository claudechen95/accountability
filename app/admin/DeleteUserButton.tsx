"use client";

import { useState } from "react";

export default function DeleteUserButton({ id, label }: { id: string; label: string }) {
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    setLoading(true);
    await fetch("/api/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    window.location.reload();
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Remove {label}?</span>
        <button
          onClick={handleDelete}
          disabled={loading}
          className="text-xs text-red-500 hover:text-red-700 font-semibold disabled:opacity-50"
        >
          {loading ? "Removing…" : "Yes, remove"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="text-xs text-gray-300 hover:text-red-400 transition-colors"
    >
      Remove
    </button>
  );
}
