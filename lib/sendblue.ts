export async function sendText(to: string, content: string): Promise<void> {
  const res = await fetch("https://api.sendblue.com/api/send-message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "sb-api-key-id": process.env.SENDBLUE_API_KEY!,
      "sb-api-secret-key": process.env.SENDBLUE_API_SECRET!,
    },
    body: JSON.stringify({
      number: to,
      from_number: process.env.SENDBLUE_FROM_NUMBER!,
      content,
    }),
  });
  if (!res.ok) {
    throw new Error(`Sendblue send failed: ${res.status} ${await res.text()}`);
  }
}
