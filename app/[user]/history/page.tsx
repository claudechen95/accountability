import { HistoryPage } from "@/app/components/HistoryView";

export default function Page({ params }: { params: { user: string } }) {
  return <HistoryPage userId={params.user} />;
}
